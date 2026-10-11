"""Fast, resumable LMS sync: create the missing sessions and upload the missing attendance.

Instead of opening every group's sessions page and reading it on screen, this
script reads every group's sessions table straight from the LMS (an HTTP fetch
from inside the logged-in browser, ~0.5s per group, several groups at once),
compares it with the exported CSVs and works out up front exactly what is
missing:

  * create  - a session in "CSV Titles" that does not exist on the LMS yet
  * edit    - a session on the LMS with the wrong title/time (same as edit.py)
  * upload  - a session with an attendance CSV whose attendance is not taken
  * reupload- attendance already taken but the CSV changed since
              (pending_reuploads.json) or FORCE_REUPLOAD is on

The full list is written to exports/lms_missing_sessions.csv before anything
is changed. Then only those items are done, using the same form-filling and
upload code as edit.py / upload.py. Groups with nothing missing cost one fetch.

Progress is saved after every step to exports/lms_fast_sync_state.json. When
a run stops (crash, closed window, Ctrl+C) the next run prints the group,
step and session it stopped at, and continues from there: the fresh scan sees
what was already created/uploaded, so nothing is done twice.

It runs in its own Chrome profile (<profile>_fast) so it never fights with the
edit.py / upload.py profile, and it does not change either of those scripts.

Usage (from the project root):
  python -X utf8 -u lms-bot/fast_sync.py            # scan, report, then sync
  python -X utf8 -u lms-bot/fast_sync.py --plan     # scan and report only
  python -X utf8 -u lms-bot/fast_sync.py --track technical --round 5 --groups CAI5_AIS4_S7,AST5_DAT1_S1

The usual .env / environment settings still apply (LMS_TRACK, ONLY_GROUPS,
LMS_ROUND, DRY_RUN, FORCE_REUPLOAD, START_FROM_DATE).
"""

import argparse
import base64
import csv
import html
import json
import os
import re
import sys
import time
from datetime import datetime


def _apply_cli_args() -> argparse.Namespace:
    # edit.py / upload.py read their settings from the environment when they
    # are imported, so the command-line options are turned into env vars first.
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--plan", action="store_true", help="scan and report only, change nothing")
    parser.add_argument("--track", help="technical | nontechnical | all")
    parser.add_argument("--groups", help="comma-separated group names")
    parser.add_argument("--round", help="round number, e.g. 5")
    args = parser.parse_args()
    if args.track:
        os.environ["LMS_TRACK"] = args.track
    if args.groups:
        os.environ["ONLY_GROUPS"] = args.groups
    if args.round:
        os.environ["LMS_ROUND"] = args.round
    os.environ.setdefault("DEBUG", "0")
    return args


ARGS = _apply_cli_args()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from playwright.sync_api import sync_playwright  # noqa: E402

import edit as E  # noqa: E402
import lms_session  # noqa: E402
import upload as U  # noqa: E402

PLAN_ONLY = ARGS.plan or E.DRY_RUN or U.DRY_RUN
SCAN_CONCURRENCY = max(1, int(os.getenv("FAST_SCAN_CONCURRENCY", "4")))
PAUSE_MS = int(os.getenv("FAST_PAUSE_MS", "300"))
# FAST_SYNC_HTTP=0 turns the direct form posts off (everything on screen).
USE_HTTP = os.getenv("FAST_SYNC_HTTP", "1").strip().lower() not in {"0", "false", "no"}

EXPORTS_ROOT = U.EXPORTS_ROOT
STATE_PATH = os.path.join(EXPORTS_ROOT, "lms_fast_sync_state.json")
PLAN_CSV_PATH = os.path.join(EXPORTS_ROOT, "lms_missing_sessions.csv")


class BlockedError(RuntimeError):
    """The LMS firewall answered with its "page blocked" screen."""


# =========================
# STATE / CHECKPOINT
# =========================
class State:
    """exports/lms_fast_sync_state.json, rewritten after every step."""

    def __init__(self):
        self.previous = self._load()
        self.data = {
            "startedAt": _now(),
            "updatedAt": _now(),
            "finished": False,
            "planOnly": PLAN_ONLY,
            "track": lms_session.track_label(E.LMS_TRACK),
            "current": None,
            "plan": {},
            "done": [],
            "failed": [],
        }

    @staticmethod
    def _load():
        try:
            with open(STATE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def report_previous_stop(self):
        prev = self.previous
        if not prev or prev.get("finished") or prev.get("planOnly"):
            return
        cur = prev.get("current") or {}
        print("\n" + "!" * 100)
        print(f"⚠️ The last run (started {prev.get('startedAt')}) did not finish.")
        if cur:
            print(
                f"   It stopped at group {cur.get('group')} | step: {cur.get('step')} | "
                f"session: {cur.get('session')} | at {cur.get('since')}"
            )
        print(
            f"   Done then: {len(prev.get('done') or [])} step(s), failed: {len(prev.get('failed') or [])}. "
            "Continuing: the scan below skips everything already on the LMS."
        )
        print("!" * 100)

    def save(self):
        self.data["updatedAt"] = _now()
        try:
            os.makedirs(EXPORTS_ROOT, exist_ok=True)
            tmp = STATE_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, STATE_PATH)
        except Exception as e:
            print(f"⚠️ Could not save {os.path.basename(STATE_PATH)}: {e}")

    def at(self, group, step, session=""):
        self.data["current"] = {"group": group, "step": step, "session": session, "since": _now()}
        self.save()

    def done(self, group, step, session):
        self.data["done"].append({"group": group, "step": step, "session": session, "at": _now()})
        self.save()

    def failed(self, group, step, session, reason):
        self.data["failed"].append(
            {"group": group, "step": step, "session": session, "reason": str(reason)[:300], "at": _now()}
        )
        self.save()

    def finish(self):
        self.data["finished"] = True
        self.data["current"] = None
        self.save()


def _now():
    return datetime.now().isoformat(timespec="seconds")


# =========================
# FAST TABLE SCAN
# =========================
# Same row reading as lms_session.parse_sessions_table, but on HTML fetched in
# the background (no page navigation). Cell texts are joined with spaces,
# which gives the same text as innerText once spaces are collapsed.
_SCAN_JS = """async ([urls, concurrency]) => {
  const out = new Array(urls.length);
  let next = 0;
  const textOf = (el) => {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) parts.push(node.nodeValue);
    return parts.join(' ');
  };
  const abs = (a) => {
    const h = a.getAttribute('href') || '';
    try { return h ? new URL(h, location.href).href : ''; } catch (e) { return h; }
  };
  const label = (a) => `${a.getAttribute('aria-label') || ''} ${a.getAttribute('title') || ''}`.toLowerCase();
  async function one(i) {
    try {
      const r = await fetch(urls[i], { credentials: 'include' });
      const html = await r.text();
      if (html.includes('has been blocked') && html.includes('Attack ID')) { out[i] = { error: 'blocked' }; return; }
      if (r.url.includes('/login/index.php')) { out[i] = { error: 'login' }; return; }
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const table = doc.querySelector('table.generaltable');
      const rows = table ? Array.from(table.querySelectorAll('tbody tr')) : [];
      out[i] = {
        status: r.status,
        has_table: !!table,
        rows: rows.map((row, index) => {
          const links = Array.from(row.querySelectorAll('a'));
          const takeLinks = links.filter((a) => (a.getAttribute('href') || '').includes('/mod/attendance/take.php'));
          const changeLink = takeLinks.find((a) =>
            label(a).includes('change attendance') ||
            Array.from(a.querySelectorAll('img')).some((img) => (img.getAttribute('src') || '').includes('redo'))
          );
          const takeLink = takeLinks.find((a) =>
            label(a).includes('take attendance') || a.querySelector("i[class*='fa-play']")
          );
          const editLink = links.find((a) => label(a).includes('edit session'));
          return {
            index,
            text: Array.from(row.cells).map(textOf).join(' ').replace(/\\s+/g, ' ').trim(),
            take_href: takeLink ? abs(takeLink) : '',
            change_href: changeLink ? abs(changeLink) : '',
            edit_href: editLink ? abs(editLink) : '',
          };
        }),
      };
    } catch (e) {
      out[i] = { error: String(e) };
    }
  }
  async function worker() { while (next < urls.length) { const i = next++; await one(i); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}"""


def scan_tables(page, urls):
    """Returns one list of rows per URL (same keys as parse_sessions_table)."""
    if not urls:
        return []
    results = page.evaluate(_SCAN_JS, [list(urls), SCAN_CONCURRENCY])
    tables = []
    for url, res in zip(urls, results):
        err = (res or {}).get("error")
        if err == "blocked":
            raise BlockedError(
                "The LMS firewall blocked a request (\"Web Page Blocked\"). Stopped; wait a "
                "while before running again."
            )
        if err == "login":
            raise RuntimeError("The LMS session expired (redirected to the login page).")
        if err:
            raise RuntimeError(f"Could not read {url}: {err}")
        if not res.get("has_table") and res.get("status") != 200:
            raise RuntimeError(f"Could not read {url}: HTTP {res.get('status')}")
        rows = []
        for row in res.get("rows") or []:
            hrefs = " ".join([row.get("edit_href", ""), row.get("change_href", ""), row.get("take_href", "")])
            match = re.search(r"sessionid=(\d+)", hrefs)
            row["session_id"] = match.group(1) if match else ""
            row["attendance_taken"] = bool(row.get("change_href"))
            rows.append(row)
        tables.append(rows)
    return tables


def lms_sessions_from_rows(rows):
    """Same output as edit.build_lms_sessions, from scanned rows."""
    out = []
    for row in rows:
        txt = " ".join(row["text"].split())
        lowered = txt.lower()
        if not txt or "no sessions" in lowered or "nothing to display" in lowered or "no data available" in lowered:
            continue
        d = E.extract_date_from_row_text(txt)
        if not d:
            continue
        title = E.extract_title_from_row_text(txt)
        out.append({
            "idx_1based": row["index"] + 1,
            "date_obj": d,
            "title": title,
            "title_norm": E.normalize_text(title),
            "row_text": txt[:500],
            "attendance_taken": row["attendance_taken"],
            "session_id": row["session_id"],
            "edit_href": row["edit_href"],
            "key": row["session_id"] or f"row:{row['index']}:{txt[:120]}",
        })
    return out


# =========================
# GROUPS
# =========================
def edit_profile_for(track):
    return next(p for p in E.PROFILES if p["track"] == track)


def upload_profile_for(track):
    return next(p for p in U.PROFILES if p["track"] == track)


def use_profiles(track):
    E._PROFILE = edit_profile_for(track)
    U._PROFILE = upload_profile_for(track)


def groups_for_track(track):
    """Groups that have a titles CSV and/or an attendance folder, with their LMS number."""
    ep, up = edit_profile_for(track), upload_profile_for(track)
    names = set()
    titles_dir = ep["CSV_DIR"]
    if os.path.isdir(titles_dir):
        for fname in os.listdir(titles_dir):
            if fname.lower().endswith(".csv"):
                names.add(E.normalize_group_name_from_filename(fname))
    base = up["EXPORTS_BASE_DIR"]
    if os.path.isdir(base):
        for fname in os.listdir(base):
            if fname != os.path.basename(titles_dir) and os.path.isdir(os.path.join(base, fname)):
                names.add(fname)

    if E.LMS_ROUND:
        names = {n for n in names if re.match(r"^[A-Za-z]{3,4}" + re.escape(E.LMS_ROUND), n)}
    if E.ONLY_GROUPS:
        names = {n for n in names if n in E.ONLY_GROUPS}

    mapped, unmapped = [], []
    for name in sorted(names):
        num = up["GROUP_TO_NUM"].get(name) or ep["GROUP_TO_NUM"].get(name)
        if num:
            titles_csv = os.path.join(titles_dir, f"{name}.csv")
            if not os.path.isfile(titles_csv):
                titles_csv = os.path.join(titles_dir, f"{name}_sessions.csv")
            mapped.append({
                "name": name,
                "num": num,
                "titles_csv": titles_csv if os.path.isfile(titles_csv) else "",
            })
        else:
            unmapped.append(name)
    return mapped, unmapped


# =========================
# PLANNING
# =========================
def plan_titles(group, lms_sessions):
    """What edit.py would do for this group's titles CSV, decided up front."""
    actions, notes = [], []
    if not group["titles_csv"]:
        return actions, notes
    rows_csv = E.read_csv_rows(group["titles_csv"])
    if not rows_csv:
        return actions, notes
    target_dates = E.build_target_dates_with_rollover(rows_csv)

    claimed, planned = set(), set()
    for idx, item in enumerate(rows_csv, start=1):
        title = item.get("title", "").strip()
        target_date = target_dates[idx - 1]
        start24, end24 = E.extract_time_range_from_title(title)
        base = {"date": target_date, "start": start24, "end": end24, "title": title, "csv_row": idx}
        if not start24 or not end24:
            notes.append({**base, "action": "skip", "reason": "could not parse time from title"})
            continue
        key = (target_date, start24, end24, E.normalize_text(title))
        exact = E.find_exact_match(lms_sessions, target_date, title, start24, end24)
        if exact or key in planned:
            if exact:
                claimed.add(exact["key"])
            continue
        candidate, how = E.choose_lms_session(lms_sessions, target_date, start24, end24, claimed)
        if how == "conflict":
            notes.append({**base, "action": "skip", "reason": "another CSV row already matched the LMS session at this date/time"})
            continue
        if candidate:
            claimed.add(candidate["key"])
            if candidate["title_norm"] == E.normalize_text(title):
                continue
            if candidate.get("attendance_taken"):
                notes.append({**base, "action": "skip", "reason": "title differs but attendance already taken; left as is"})
                continue
            actions.append({**base, "action": "edit", "candidate": candidate})
        else:
            planned.add(key)
            actions.append({**base, "action": "create"})
    return actions, notes


def plan_uploads(group, rows):
    """What upload.py would do for this group, decided up front."""
    actions, notes = [], []
    csv_start, csv_end = U.get_csv_date_range_for_group(group["name"])
    if csv_start is None and not U.GLOBAL_START_FROM_DATE:
        return actions, notes
    start_from = U.GLOBAL_START_FROM_DATE or csv_start

    for row in rows:
        text = row["text"]
        if not text:
            continue
        row_date = U.extract_date_from_row_text(text)
        if start_from and (row_date is None or row_date < start_from):
            continue
        if csv_end and row_date and row_date > csv_end:
            continue
        taken = row["attendance_taken"]
        if not taken and not row["take_href"]:
            continue
        if not row_date:
            if not taken:
                notes.append({"date": None, "action": "skip", "title": text[:120], "reason": "could not parse the LMS row date"})
            continue
        row_group = U.extract_group_from_row_text(text) or group["name"]
        session_title = U.extract_session_title_from_row_text(text)
        session_type = U.extract_session_type_from_title(session_title)
        base = {"date": row_date, "title": session_title, "row_group": row_group, "session_id": row["session_id"]}
        try:
            csv_path = U.find_csv_for_session(row_group, row_date, session_type)
        except RuntimeError as e:
            if not taken:
                notes.append({**base, "action": "skip", "reason": f"no attendance CSV: {e}"})
            continue
        key = U.pending_reupload_key(csv_path)
        if taken:
            if key in U.PENDING_REUPLOADS or U.FORCE_REUPLOAD:
                reason = "CSV changed since the last upload" if key in U.PENDING_REUPLOADS else "re-upload option is on"
                actions.append({**base, "action": "reupload", "csv_path": csv_path, "href": row["change_href"], "reason": reason})
            continue
        actions.append({**base, "action": "upload", "csv_path": csv_path, "href": row["take_href"]})
    return actions, notes


def describe(item):
    d = item.get("date")
    when = d.isoformat() if d else "?"
    if item.get("start"):
        when += f" {item['start']}-{item['end']}"
    return f"{when} | {str(item.get('title', ''))[:70]}"


def write_plan_csv(plan_rows):
    os.makedirs(EXPORTS_ROOT, exist_ok=True)
    fields = ["profile", "group", "action", "date", "time", "title_or_type", "csv_file", "reason"]
    try:
        with open(PLAN_CSV_PATH, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(plan_rows)
        print(f"📋 Missing list saved: {PLAN_CSV_PATH} ({len(plan_rows)} rows)")
    except Exception as e:
        print(f"⚠️ Could not save {PLAN_CSV_PATH} (is it open in Excel?): {e}")


def plan_row(profile_name, group_name, item):
    d = item.get("date")
    return {
        "profile": profile_name,
        "group": group_name,
        "action": "create + upload" if item["action"] == "create" and item.get("csv_path") else item["action"],
        "date": d.isoformat() if d else "",
        "time": f"{item['start']}-{item['end']}" if item.get("start") else "",
        "title_or_type": item.get("title", ""),
        "csv_file": os.path.basename(item.get("csv_path", "") or ""),
        "reason": item.get("reason", ""),
    }


# =========================
# ACTIONS ON THE LMS (browser, same steps as edit.py / upload.py)
# =========================
def cmid_from_url(target_url):
    m = re.search(r"[?&]id=(\d+)", target_url)
    return m.group(1) if m else ""


def open_add_form(page, target_url):
    """Opens the Add session form directly (the table page is not loaded first)."""
    page.goto(f"{lms_session.LMS_BASE_URL}/mod/attendance/sessions.php?id={cmid_from_url(target_url)}&action=1")
    E.wait_dom_ready(page)
    E.dismiss_popups(page)
    try:
        expand_all = page.locator("button, a").filter(has_text=re.compile(r"expand all", re.I)).first
        if expand_all.count() > 0 and expand_all.is_visible(timeout=1500):
            expand_all.click()
            page.wait_for_timeout(400)
    except Exception:
        pass
    try:
        page.locator("select[name='groups[]'], #id_groups").first.wait_for(state="visible", timeout=8000)
    except Exception:
        # Direct link refused: fall back to the Add session button on the table.
        E.goto_add_session_page(page, target_url)


def do_create(page, group, target_url, item):
    open_add_form(page, target_url)
    E.set_group_for_add_session(page, group["name"])
    E.set_date_dropdowns(page, item["date"])
    E.set_time_dropdowns(page, item["start"], item["end"])
    E.set_description_tinymce(page, item["title"])
    E.submit_add_session(page)


def do_edit(page, target_url, item):
    E.open_edit_form(page, item["candidate"], target_url)
    E.set_description_tinymce(page, item["title"])
    E.set_date_dropdowns(page, item["date"])
    E.set_time_dropdowns(page, item["start"], item["end"])
    E.save_changes(page)


def do_upload(page, item):
    page.goto(item["href"])
    U.wait_dom_ready(page)
    U.dismiss_popups(page)
    U.upload_attendance_csv_for_current_session(page, item["csv_path"], item["row_group"])


# =========================
# DIRECT FORM SUBMISSION (no clicking)
# The same Moodle forms the browser shows are fetched, filled and posted from
# inside the logged-in page. Every step checks the LMS answer before the next
# one (form found, file stored, "Sessions updated" shown), so nothing depends
# on how fast a page renders. Any surprise raises, and the caller falls back
# to the on-screen steps above.
# =========================
_HTTP_COMMON_JS = """
  const parse = (h) => new DOMParser().parseFromString(h, 'text/html');
  const blocked = (h) => h.includes('has been blocked') && h.includes('Attack ID');
  const texts = (doc, sel) => Array.from(doc.querySelectorAll(sel))
    .map((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
  const get = async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    return { url: r.url, status: r.status, html: await r.text() };
  };
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', body, credentials: 'include' });
    return { url: r.url, status: r.status, html: await r.text() };
  };
  const check = (res, what) => {
    if (blocked(res.html)) throw { blocked: true };
    if (res.url.includes('/login/index.php')) throw { error: 'the LMS session expired (login page)' };
    if (res.status >= 400) throw { error: `${what}: HTTP ${res.status}` };
    return parse(res.html);
  };
"""

_HTTP_CREATE_JS = """async ([addUrl, groupValue, groupName, y, m, d, sh, sm, eh, em, descHtml]) => {
""" + _HTTP_COMMON_JS + """
  try {
    const doc = check(await get(addUrl), 'add-session form');
    const form = Array.from(doc.querySelectorAll('form'))
      .find((f) => f.querySelector('[name=_qf__mod_attendance_form_addsession]'));
    if (!form) return { error: 'the Add session form was not found' };
    const select = form.querySelector('select[name="groups[]"]');
    const options = select ? Array.from(select.options) : [];
    const option = options.find((o) => o.value === String(groupValue))
      || options.find((o) => o.textContent.trim() === groupName);
    if (!option) return { error: `group ${groupName} is not in the form's group list` };

    const fd = new FormData(form);
    fd.delete('groups[]');
    fd.append('groups[]', option.value);
    const values = {
      'sessiondate[day]': d, 'sessiondate[month]': m, 'sessiondate[year]': y,
      'sestime[starthour]': sh, 'sestime[startminute]': sm,
      'sestime[endhour]': eh, 'sestime[endminute]': em,
      'sdescription[text]': descHtml, 'sdescription[format]': 1,
    };
    for (const [k, v] of Object.entries(values)) fd.set(k, String(v));
    fd.set('submitbutton', form.querySelector('[name=submitbutton]').value);

    const res = await post(form.getAttribute('action'), fd);
    const out = check(res, 'saving the session');
    if (out.querySelector('[name=_qf__mod_attendance_form_addsession]')) {
      const errors = texts(out, '.invalid-feedback, .error, .alert-danger');
      return { error: 'the LMS refused the form: ' + (errors.join(' | ') || 'no message') };
    }
    return { ok: true };
  } catch (e) {
    if (e && e.blocked) return { blocked: true };
    return { error: (e && e.error) || String(e) };
  }
}"""

_HTTP_UPLOAD_JS = """async ([takeUrl, fileName, fileB64]) => {
""" + _HTTP_COMMON_JS + """
  try {
    // 1) "Upload attendance by CSV" button on the take page.
    let doc = check(await get(takeUrl), 'take attendance page');
    let form = Array.from(doc.querySelectorAll('form'))
      .find((f) => (f.getAttribute('action') || '').includes('/import/marksessions.php'));
    if (!form) return { error: 'the "Upload attendance by CSV" button was not found' };
    let res = await post(form.getAttribute('action'), new FormData(form));
    doc = check(res, 'upload form');
    form = Array.from(doc.querySelectorAll('form'))
      .find((f) => f.querySelector('[name=_qf__mod_attendance_form_import_marksessions]'));
    const fileField = form && form.querySelector('[name=attendancefile]');
    const clientId = (res.html.match(/"client_id":"([^"]+)"/) || [])[1];
    const ctxId = (res.html.match(/ctx_id=(\\d+)/) || [])[1];
    const repoId = (res.html.match(/"(\\d+)":\\{"id":"\\d+","name":"[^"]*","type":"upload"/) || [])[1];
    if (!form || !fileField || !clientId || !ctxId || !repoId) return { error: 'the CSV upload form looks different than expected' };

    // 2) Store the CSV in the form's draft area (what the file picker does).
    const bytes = Uint8Array.from(atob(fileB64), (c) => c.charCodeAt(0));
    const up = new FormData();
    up.append('repo_upload_file', new Blob([bytes], { type: 'text/csv' }), fileName);
    const fields = {
      title: fileName, author: '', license: 'unknown', itemid: fileField.value, repo_id: repoId,
      p: '', page: '', env: 'filepicker', sesskey: form.querySelector('[name=sesskey]').value,
      client_id: clientId, maxbytes: '-1', areamaxbytes: '-1', ctx_id: ctxId, savepath: '/',
    };
    for (const [k, v] of Object.entries(fields)) up.append(k, v);
    res = await post('/repository/repository_ajax.php?action=upload', up);
    if (blocked(res.html)) return { blocked: true };
    let stored = null;
    try { stored = JSON.parse(res.html); } catch (e) { /* handled below */ }
    if (!stored || stored.error || !stored.id) {
      return { error: 'the CSV was not accepted: ' + ((stored && stored.error) || res.html.slice(0, 200)) };
    }

    // 3) Submit the file -> column mapping page.
    let fd = new FormData(form);
    fd.set('submitbutton', form.querySelector('[name=submitbutton]').value);
    doc = check(await post(form.getAttribute('action'), fd), 'submitting the CSV');
    form = Array.from(doc.querySelectorAll('form'))
      .find((f) => f.querySelector('[name=_qf__mod_attendance_form_import_marksessions_confirm]'));
    const userTo = form && form.querySelector('select[name=userto]');
    if (!form || !userTo || !Array.from(userTo.options).some((o) => o.value === 'email')) {
      const errors = texts(doc, '.invalid-feedback, .error, .alert');
      return { error: 'the column mapping page did not open: ' + (errors.join(' | ') || 'no message') };
    }

    // 4) Moodle user field = Email address, then confirm: this saves the attendance.
    fd = new FormData(form);
    fd.set('userto', 'email');
    fd.set('submitbutton', form.querySelector('[name=submitbutton]').value);
    doc = check(await post(form.getAttribute('action'), fd), 'confirming the import');
    const alerts = texts(doc, '.alert, [role=alert]');
    if (doc.querySelector('[name=_qf__mod_attendance_form_import_marksessions_confirm]')) {
      return { error: 'the import was not confirmed: ' + (alerts.join(' | ') || 'no message') };
    }
    if (!alerts.some((a) => /sessions? updated/i.test(a))) {
      return { error: 'no "Sessions updated" message after the import: ' + (alerts.join(' | ') || 'no message') };
    }
    return { ok: true, alerts };
  } catch (e) {
    if (e && e.blocked) return { blocked: true };
    return { error: (e && e.error) || String(e) };
  }
}"""


class _AlertTexts:
    """Lets upload.collect_missing_from_wavz read alerts that were fetched, not shown."""

    def __init__(self, texts):
        self.texts = list(texts or [])

    def locator(self, _selector):
        return self

    def all_inner_texts(self):
        return self.texts


def _http_result(res, what):
    if res.get("blocked"):
        raise BlockedError(
            "The LMS firewall blocked a request (\"Web Page Blocked\"). Stopped; wait a "
            "while before running again."
        )
    if not res.get("ok"):
        raise RuntimeError(f"{what}: {res.get('error') or 'unknown error'}")
    return res


def http_create(page, group, target_url, item):
    group_value = E._PROFILE.get("GROUP_OPTION_VALUES", {}).get(group["name"], group["num"])
    sh, sm = map(int, item["start"].split(":"))
    eh, em = map(int, item["end"].split(":"))
    d = item["date"]
    desc = "<p>" + html.escape(item["title"], quote=False) + "</p>"
    add_url = f"{lms_session.LMS_BASE_URL}/mod/attendance/sessions.php?id={cmid_from_url(target_url)}&action=1"
    res = page.evaluate(
        _HTTP_CREATE_JS,
        [add_url, str(group_value), group["name"], d.year, d.month, d.day, sh, sm, eh, em, desc],
    )
    _http_result(res, "direct create")


def http_upload(page, item):
    with open(item["csv_path"], "rb") as f:
        data = base64.b64encode(f.read()).decode("ascii")
    res = page.evaluate(_HTTP_UPLOAD_JS, [item["href"], os.path.basename(item["csv_path"]), data])
    _http_result(res, "direct upload")
    U.collect_missing_from_wavz(_AlertTexts(res.get("alerts")), item["row_group"], item["csv_path"])


# =========================
# ONE GROUP
# =========================
def sync_group(page, state, profile_name, group, target_url, rows, title_actions):
    name = group["name"]
    stats = {"created": 0, "edited": 0, "uploaded": 0, "reuploaded": 0, "failed": 0}
    started = time.time()
    print("\n" + "=" * 100)
    print(f"🧩 {profile_name} | {name} | {target_url}")
    print("=" * 100)

    # 1) Create / fix the sessions.
    for item in title_actions:
        label = describe(item)
        state.at(name, item["action"], label)
        # A create is tried once with a direct form post and, if that fails,
        # once on screen; an edit is done on screen.
        attempts = 2 if item["action"] == "create" else 1
        for attempt in range(1, attempts + 1):
            try:
                t = time.time()
                if item["action"] == "create":
                    direct = USE_HTTP and attempt == 1
                    print(f"➕ Creating{'' if direct else ' (on screen)'}: {label}")
                    if direct:
                        http_create(page, group, target_url, item)
                    else:
                        do_create(page, group, target_url, item)
                else:
                    print(f"✏️ Editing: {label}")
                    do_edit(page, target_url, item)
                print(f"   saved in {time.time() - t:.1f}s")
                break
            except BlockedError:
                raise
            except Exception as e:
                print(f"❌ {item['action']} failed (attempt {attempt}): {e}")
                # Before trying again, check the LMS: the session may have been
                # saved even though the page did not finish loading.
                fresh = lms_sessions_from_rows(scan_tables(page, [target_url])[0])
                if E.find_exact_match(fresh, item["date"], item["title"], item["start"], item["end"]):
                    print("ℹ️ The LMS already has it, so it is counted as done.")
                    break
                if attempt == attempts:
                    stats["failed"] += 1
                    state.failed(name, item["action"], label, e)
                    item["failed"] = True
        page.wait_for_timeout(PAUSE_MS)

    # 2) One fresh read verifies every change and gives the new sessions'
    #    links for the uploads.
    if title_actions:
        rows = scan_tables(page, [target_url])[0]
        fresh = lms_sessions_from_rows(rows)
        for item in title_actions:
            if item.get("failed"):
                continue
            label = describe(item)
            if E.find_exact_match(fresh, item["date"], item["title"], item["start"], item["end"]):
                stats["created" if item["action"] == "create" else "edited"] += 1
                state.done(name, item["action"], label)
            else:
                stats["failed"] += 1
                print(f"❌ Not found on the LMS after the {item['action']}: {label}")
                state.failed(name, item["action"], label, "not found on the LMS after saving")

    # 3) Upload the attendance that is still missing.
    upload_actions, _ = plan_uploads(group, rows)
    for item in upload_actions:
        label = describe(item)
        state.at(name, item["action"], f"{label} | {os.path.basename(item['csv_path'])}")
        try:
            print(f"{'♻️ Re-uploading' if item['action'] == 'reupload' else '⬆️ Uploading'}: {label} <- {os.path.basename(item['csv_path'])}")
            t = time.time()
            done_direct = False
            if USE_HTTP:
                try:
                    http_upload(page, item)
                    done_direct = True
                except BlockedError:
                    raise
                except Exception as e:
                    # Uploading the same CSV again only rewrites the same marks,
                    # so the on-screen upload is safe even if this one got far.
                    print(f"⚠️ {e} -> uploading on screen instead")
            if not done_direct:
                do_upload(page, item)
            print(f"   uploaded in {time.time() - t:.1f}s")
            key = U.pending_reupload_key(item["csv_path"])
            item["pending"] = (key, U.PENDING_REUPLOADS.pop(key, None))
            if item["pending"][1] is not None:
                U.save_pending_reuploads()
        except BlockedError:
            raise
        except Exception as e:
            stats["failed"] += 1
            item["failed"] = True
            print(f"❌ Upload failed: {e}")
            state.failed(name, item["action"], label, e)
        page.wait_for_timeout(PAUSE_MS)

    # 4) One fresh read verifies every upload.
    if any(not i.get("failed") for i in upload_actions):
        after = {r["session_id"]: r for r in scan_tables(page, [target_url])[0] if r["session_id"]}
        for item in upload_actions:
            if item.get("failed"):
                continue
            label = describe(item)
            row = after.get(item["session_id"])
            if row and row["attendance_taken"]:
                stats["reuploaded" if item["action"] == "reupload" else "uploaded"] += 1
                state.done(name, item["action"], label)
            else:
                stats["failed"] += 1
                print(f"❌ Attendance not shown as taken after the upload: {label}")
                state.failed(name, item["action"], label, "attendance not shown as taken after the upload")
                key, info = item.get("pending") or (None, None)
                if info is not None:
                    U.PENDING_REUPLOADS[key] = info
                    U.save_pending_reuploads()

    print(
        f"✅ DONE {name} | created={stats['created']} | edited={stats['edited']} | "
        f"uploaded={stats['uploaded']} | reuploaded={stats['reuploaded']} | failed={stats['failed']} "
        f"| {time.time() - started:.1f}s"
    )
    return stats


# =========================
# MAIN
# =========================
def open_browser(p, email, password):
    # Its own profile folder, so it never shares (or locks) the one used by
    # edit.py / upload.py. The LMS firewall blocks headless browsers, so the
    # window is visible like the other bots.
    user_data_dir = lms_session.user_data_dir_for(email) + "_fast"
    lms_session.harden_chrome_profile(user_data_dir)
    context = p.chromium.launch_persistent_context(
        user_data_dir=user_data_dir,
        headless=False,
        channel="chrome",
        args=lms_session.CHROME_LAUNCH_ARGS,
    )
    page = context.new_page()
    page.set_default_timeout(E.DEFAULT_TIMEOUT_MS)
    E.ensure_logged_in(page, email, password)
    return context, page


def main():
    run_started = time.time()
    state = State()
    state.report_previous_stop()

    print(f"🎛️ Track: {lms_session.track_label(E.LMS_TRACK)} | mode: {'PLAN ONLY (nothing is changed)' if PLAN_ONLY else 'sync'}")
    if U.FORCE_REUPLOAD:
        print("♻️ Re-upload option is ON: sessions that already have attendance are uploaded again.")
    U.load_student_status()
    U.load_existing_missing_from_wavz()
    U.load_pending_reuploads()

    tracks = [p["track"] for p in E.PROFILES if lms_session.track_is_selected(p["track"])]
    if not tracks:
        print("❌ No profile matches the selected track.")
        return

    plan_rows = []
    totals = {"created": 0, "edited": 0, "uploaded": 0, "reuploaded": 0, "failed": 0}
    stopped = None

    with sync_playwright() as p:
        context = None
        current_email = None
        try:
            for track in tracks:
                use_profiles(track)
                profile_name = E._PROFILE["name"]
                groups, unmapped = groups_for_track(track)
                for name in unmapped:
                    print(f"⚠️ {profile_name}: no LMS group number for {name}; skipped.")
                    plan_rows.append({"profile": profile_name, "group": name, "action": "skip", "reason": "no LMS group number"})
                if not groups:
                    print(f"ℹ️ {profile_name}: no groups to check.")
                    continue

                email, password = lms_session.account_for_track(track)
                if context is not None and email != current_email:
                    context.close()
                    context = None
                if context is None:
                    context, page = open_browser(p, email, password)
                    current_email = email

                # ---- SCAN every group in one go ----
                state.at("(scan)", "scan", f"{profile_name}: {len(groups)} groups")
                urls = [U.build_target_url(g["num"], g["name"]) for g in groups]
                t = time.time()
                tables = scan_tables(page, urls)
                print(f"\n⚡ {profile_name}: read {len(groups)} group tables in {time.time() - t:.1f}s")

                # ---- PLAN ----
                work = []
                for group, url, rows in zip(groups, urls, tables):
                    title_actions, title_notes = plan_titles(group, lms_sessions_from_rows(rows))
                    upload_actions, upload_notes = plan_uploads(group, rows)
                    # A session that is about to be created is uploaded right
                    # after, when its attendance CSV already exists.
                    extra_uploads = 0
                    for item in title_actions:
                        if item["action"] != "create":
                            continue
                        try:
                            session_type = U.extract_session_type_from_title(item["title"])
                            item["csv_path"] = U.find_csv_for_session(group["name"], item["date"], session_type)
                            extra_uploads += 1
                        except Exception:
                            pass
                    for item in title_actions + title_notes + upload_actions + upload_notes:
                        plan_rows.append(plan_row(profile_name, group["name"], item))
                    counts = {
                        "create": sum(1 for i in title_actions if i["action"] == "create"),
                        "edit": sum(1 for i in title_actions if i["action"] == "edit"),
                        "upload": sum(1 for i in upload_actions if i["action"] == "upload") + extra_uploads,
                        "reupload": sum(1 for i in upload_actions if i["action"] == "reupload"),
                    }
                    state.data["plan"][group["name"]] = counts
                    if any(counts.values()):
                        work.append((group, url, rows, title_actions, counts))

                print("\n" + "-" * 100)
                print(f"📋 {profile_name}: {len(work)} of {len(groups)} groups have something missing")
                for group, _, _, _, counts in work:
                    print(
                        f"   {group['name']:<16} create={counts['create']:<3} edit={counts['edit']:<3} "
                        f"upload={counts['upload']:<3} reupload={counts['reupload']}"
                    )
                print("-" * 100)
                state.save()

                if PLAN_ONLY:
                    continue

                # ---- SYNC only what is missing ----
                for group, url, rows, title_actions, _ in work:
                    stats = sync_group(page, state, profile_name, group, url, rows, title_actions)
                    for k in totals:
                        totals[k] += stats[k]
        except BlockedError as e:
            stopped = str(e)
        except KeyboardInterrupt:
            stopped = "stopped by the user (Ctrl+C)"
        except Exception as e:
            stopped = f"{type(e).__name__}: {e}"
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass

    write_plan_csv(plan_rows)
    if U.MISSING_FROM_WAVZ_ROWS:
        try:
            U.write_missing_from_wavz()
        except Exception as e:
            print(f"⚠️ Could not save the missing-from-Wavz report: {e}")

    print("\n" + "#" * 100)
    if stopped:
        cur = state.data.get("current") or {}
        state.save()
        print(f"⛔ Stopped: {stopped}")
        print(
            f"   Last position: group {cur.get('group')} | step: {cur.get('step')} | session: {cur.get('session')}"
        )
        print("   Run it again to continue from there (finished steps are not repeated).")
    else:
        state.finish()
        print("✅ Finished.")
    if not PLAN_ONLY:
        print(
            f"   created={totals['created']} | edited={totals['edited']} | uploaded={totals['uploaded']} | "
            f"reuploaded={totals['reuploaded']} | failed={totals['failed']}"
        )
        for f in state.data["failed"]:
            print(f"   ❌ {f['group']} | {f['step']} | {f['session']} | {f['reason']}")
    print(f"   Progress file: {STATE_PATH}")
    print(f"   Total time: {time.time() - run_started:.1f}s")
    print("#" * 100)
    if stopped:
        sys.exit(1)


if __name__ == "__main__":
    main()
