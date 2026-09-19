import csv
import re
import os
import glob
import sys
import json
from datetime import datetime, date
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

import lms_session

load_dotenv()
lms_session.load_env()

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


def parse_only_groups(raw_value: str) -> set[str]:
    return {
        item.strip()
        for item in (raw_value or "").split(",")
        if item.strip()
    }

# =========================
# CONFIG
# =========================
LOGIN_URL = lms_session.LOGIN_URL

VIEW = int(os.getenv("LMS_VIEW", "4").strip() or "4")
COURSE_MODULE_ID_OVERRIDE = os.getenv("LMS_COURSE_MODULE_ID", "").strip()
ROUND_5_TECHNICAL_COURSE_MODULE_ID = "6879"
ROUND_5_NON_TECHNICAL_COURSE_MODULE_ID = "7743"

LMS_TRACK = lms_session.selected_track()

DEFAULT_TIMEOUT_MS = int(os.getenv("DEFAULT_TIMEOUT_MS", "25000"))
SHORT_TIMEOUT_MS = int(os.getenv("SHORT_TIMEOUT_MS", "6000"))
INTER_SESSION_PAUSE_MS = int(os.getenv("INTER_SESSION_PAUSE_MS", "1500"))

DEBUG = os.getenv("DEBUG", "1").strip().lower() not in {"0", "false", "no"}
# DRY_RUN=true prints what would be edited or created without touching the LMS.
DRY_RUN = os.getenv("DRY_RUN", "false").strip().lower() == "true"
ONLY_GROUPS = parse_only_groups(os.getenv("ONLY_GROUPS", ""))
LMS_ROUND = os.getenv("LMS_ROUND", "").strip()

with open(os.path.join(os.path.dirname(__file__), "round5_groups.json"), encoding="utf-8") as f:
    ROUND_5_GROUPS = {name: int(number) for name, number in json.load(f).items()}

with open(
    os.path.join(os.path.dirname(__file__), "round5_nontechnical_groups.json"),
    encoding="utf-8",
) as f:
    ROUND_5_NON_TECHNICAL_GROUPS = {name: int(number) for name, number in json.load(f).items()}

# =========================
# PROFILES
# =========================
PROFILES = [
    {
        "name": "Technical",
        "track": lms_session.TRACK_TECHNICAL,
        "COURSE_MODULE_ID": 2971,
        "ROUND_5_COURSE_MODULE_ID": ROUND_5_TECHNICAL_COURSE_MODULE_ID,
        "CSV_DIR": r"C:\Users\mohab\Desktop\eyouth-Attendence\exports\Technical groups\CSV Titles",
        "GROUP_TO_NUM": {
            "CAI4_SWD1_S2": 5601,
            "GHR4_SWD1_S1": 5670,
            "GIZ4_SWD1_S1": 5603,
            "MNF4_SWD1_S1": 5671,
            "CAI4_SWD2_S1": 5644,
            "CAI4_SWD2_S2": 5647,
            "GIZ4_SWD2_S5": 5604,
            "MNF4_SWD2_S1": 5605,
            "MNF4_SWD2_S2": 5606,
            "GHR4_SWD4_S1": 5672,
            "ONL4_DRT6_S1": 5628,
            "GIZ4_DRT5_S1": 6036,
            "AST4_AIS4_S1": 5649,
            "GHR4_AIS4_S1": 5654,
            "GIZ4_AIS4_S3": 5657,
            "GIZ4_AIS4_S4": 5660,
            "MNF4_AIS4_S1": 5661,
            "ONL4_AIS4_S1": 5664,
            "CAI4_AIS3_S3": 5663,
            "CAI4_AIS3_S2": 5662,
            "CAI4_AIS2_S11": 5641,
            "CAI4_AIS2_S12": 5645,
            "CAI4_AIS2_S13": 5648,
            "CAI4_AIS2_S2": 5652,
            "GHR4_AIS2_S1": 5640,
            "GIZ4_AIS2_S5": 5658,
            "MNF4_AIS2_S1": 5656,
            "ONL4_AIS2_S5": 5653,
            "ONL4_AIS2_S4": 5650,
            "GIZ4_DAT1_S4": 5646,
            "ONL4_AIS2_S11": 6898,
            "ONL4_AIS5_S10": 6894,
            "CAI4_AIS2_S3": 5655,
            "CAI4_SWD1_G1": 5639,
            "CAI4_SWD2_G1": 5642,
            "ONL4_SWD4_G1": 5608,
            "GIZ4_DRT5_G1": 6032,
            "ONL4_AIS4_G2": 5666,
            "ONL4_AIS3_G3": 5624,
            "CAI4_AIS5_G4": 5665,
            "GIZ4_DAT1_G4": 5625,
            "GIZ4_DAT1_G3": 5623,
            # ISS / new groups
            "ALX4_ISS2_S1": 7165,
            "ALX4_ISS3_S1": 7327,
            "ALX4_ISS6_S1": 7385,
            "CAI4_AIS5_G2": 7215,
            "CAI4_AIS5_G3": 7482,
            "CAI4_AIS5_S2": 6992,
            "CAI4_AIS5_S4": 7182,
            "CAI4_ISS10_G1": 7465,
            "CAI4_ISS10_S1": 7254,
            "CAI4_ISS2_G1": 7357,
            "CAI4_ISS2_S1": 7373,
            "CAI4_ISS2_S2": 7330,
            "CAI4_ISS3_G1": 7220,
            "CAI4_ISS3_S1": 7378,
            "CAI4_ISS3_S2": 7456,
            "CAI4_ISS3_S3": 7288,
            "CAI4_ISS3_S4": 7420,
            "CAI4_ISS6_G1": 7390,
            "CAI4_ISS6_S1": 7371,
            "CAI4_ISS6_S2": 7376,
            "CAI4_ISS6_S3": 7274,
            "CAI4_ISS7_S1": 7313,
            "GHR4_ISS3_S1": 7468,
            "GIZ4_AIS5_G1": 7352,
            "GIZ4_AIS5_S3": 7401,
            "GIZ4_ISS2_S1": 7359,
            "GIZ4_ISS3_S1": 7319,
            **ROUND_5_GROUPS,
        },
        "GROUP_OPTION_VALUES": {
            "CAI4_SWD1_S2": "5601",
            "GHR4_SWD1_S1": "5670",
            "GIZ4_SWD1_S1": "5603",
            "MNF4_SWD1_S1": "5671",
            "CAI4_SWD2_S1": "5644",
            "CAI4_SWD2_S2": "5647",
            "GIZ4_SWD2_S5": "5604",
            "MNF4_SWD2_S1": "5605",
            "MNF4_SWD2_S2": "5606",
            "GHR4_SWD4_S1": "5672",
            "ONL4_DRT6_S1": "5628",
            "GIZ4_DRT5_S1": "6036",
            "AST4_AIS4_S1": "5649",
            "GHR4_AIS4_S1": "5654",
            "GIZ4_AIS4_S3": "5657",
            "GIZ4_AIS4_S4": "5660",
            "MNF4_AIS4_S1": "5661",
            "ONL4_AIS4_S1": "5664",
            "CAI4_AIS3_S3": "5663",
            "CAI4_AIS3_S2": "5662",
            "CAI4_AIS2_S11": "5641",
            "CAI4_AIS2_S12": "5645",
            "CAI4_AIS2_S13": "5648",
            "CAI4_AIS2_S2": "5652",
            "GHR4_AIS2_S1": "5640",
            "GIZ4_AIS2_S5": "5658",
            "MNF4_AIS2_S1": "5656",
            "ONL4_AIS2_S5": "5653",
            "ONL4_AIS2_S4": "5650",
            "GIZ4_DAT1_S4": "5646",
            "ONL4_AIS2_S11": "6898",
            "ONL4_AIS5_S10": "6894",
            "CAI4_AIS2_S3": "5655",
            "CAI4_SWD1_G1": "5639",
            "CAI4_SWD2_G1": "5642",
            "ONL4_SWD4_G1": "5608",
            "GIZ4_DRT5_G1": "6032",
            "ONL4_AIS4_G2": "5666",
            "ONL4_AIS3_G3": "5624",
            "CAI4_AIS5_G4": "5665",
            "GIZ4_DAT1_G4": "5625",
            "GIZ4_DAT1_G3": "5623",
            **{name: str(number) for name, number in ROUND_5_GROUPS.items()},
        },
    },
    {
        "name": "Non-Technical",
        "track": lms_session.TRACK_NON_TECHNICAL,
        "COURSE_MODULE_ID": 6053,
        "ROUND_5_COURSE_MODULE_ID": ROUND_5_NON_TECHNICAL_COURSE_MODULE_ID,
        "CSV_DIR": r"C:\Users\mohab\Desktop\eyouth-Attendence\exports\Non Technical groups\CSV Titles",
        "GROUP_TO_NUM": {
            "CAI4_SWD1_S2": 5601,
            "GHR4_SWD1_S1": 5670,
            "GIZ4_SWD1_S1": 5603,
            "MNF4_SWD1_S1": 5671,
            "CAI4_SWD2_S1": 5644,
            "CAI4_SWD2_S2": 5647,
            "GIZ4_SWD2_S5": 5604,
            "MNF4_SWD2_S1": 5605,
            "MNF4_SWD2_S2": 5606,
            "GHR4_SWD4_S1": 5672,
            "ONL4_DRT6_S1": 5628,
            "GIZ4_DRT5_S1": 6036,
            "AST4_AIS4_S1": 5649,
            "GHR4_AIS4_S1": 5654,
            "GIZ4_AIS4_S3": 5657,
            "GIZ4_AIS4_S4": 5660,
            "MNF4_AIS4_S1": 5661,
            "ONL4_AIS4_S1": 5664,
            "CAI4_AIS3_S3": 5663,
            "CAI4_AIS3_S2": 5662,
            "CAI4_AIS2_S11": 5641,
            "CAI4_AIS2_S12": 5645,
            "CAI4_AIS2_S13": 5648,
            "CAI4_AIS2_S2": 5652,
            "GHR4_AIS2_S1": 5640,
            "GIZ4_AIS2_S5": 5658,
            "MNF4_AIS2_S1": 5656,
            "ONL4_AIS2_S5": 5653,
            "ONL4_AIS2_S4": 5650,
            "GIZ4_DAT1_S4": 5646,
            "ONL4_AIS2_S11": 6898,
            "ONL4_AIS5_S10": 6894,
            "CAI4_AIS2_S3": 5655,
            "CAI4_SWD1_G1": 5639,
            "CAI4_SWD2_G1": 5642,
            "ONL4_SWD4_G1": 5608,
            "GIZ4_DRT5_G1": 6032,
            "ONL4_AIS4_G2": 5666,
            "ONL4_AIS3_G3": 5624,
            "CAI4_AIS5_G4": 5665,
            "GIZ4_DAT1_G4": 5625,
            "GIZ4_DAT1_G3": 5623,
            # ISS / new groups
            "ALX4_ISS2_S1": 7165,
            "ALX4_ISS3_S1": 7327,
            "ALX4_ISS6_S1": 7385,
            "CAI4_AIS5_G2": 7215,
            "CAI4_AIS5_G3": 7482,
            "CAI4_AIS5_S2": 6992,
            "CAI4_AIS5_S4": 7182,
            "CAI4_ISS10_G1": 7465,
            "CAI4_ISS10_S1": 7254,
            "CAI4_ISS2_G1": 7357,
            "CAI4_ISS2_S1": 7373,
            "CAI4_ISS2_S2": 7330,
            "CAI4_ISS3_G1": 7220,
            "CAI4_ISS3_S1": 7378,
            "CAI4_ISS3_S2": 7456,
            "CAI4_ISS3_S3": 7288,
            "CAI4_ISS3_S4": 7420,
            "CAI4_ISS6_G1": 7390,
            "CAI4_ISS6_S1": 7371,
            "CAI4_ISS6_S2": 7376,
            "CAI4_ISS6_S3": 7274,
            "CAI4_ISS7_S1": 7313,
            "GHR4_ISS3_S1": 7468,
            "GIZ4_AIS5_G1": 7352,
            "GIZ4_AIS5_S3": 7401,
            "GIZ4_ISS2_S1": 7359,
            "GIZ4_ISS3_S1": 7319,
            **ROUND_5_NON_TECHNICAL_GROUPS,
        },
        "GROUP_OPTION_VALUES": {
            "ALX4_ISS2_S1": "7165",
            "ALX4_ISS3_S1": "7327",
            "ALX4_ISS6_S1": "7385",
            "CAI4_AIS5_G2": "7215",
            "CAI4_AIS5_G3": "7482",
            "CAI4_AIS5_S2": "6992",
            "CAI4_AIS5_S4": "7182",
            "CAI4_ISS10_G1": "7465",
            "CAI4_ISS10_S1": "7254",
            "CAI4_ISS2_G1": "7357",
            "CAI4_ISS2_S1": "7373",
            "CAI4_ISS2_S2": "7330",
            "CAI4_ISS3_G1": "7220",
            "CAI4_ISS3_S1": "7378",
            "CAI4_ISS3_S2": "7456",
            "CAI4_ISS3_S3": "7288",
            "CAI4_ISS3_S4": "7420",
            "CAI4_ISS6_G1": "7390",
            "CAI4_ISS6_S1": "7371",
            "CAI4_ISS6_S2": "7376",
            "CAI4_ISS6_S3": "7274",
            "CAI4_ISS7_S1": "7313",
            "GHR4_ISS3_S1": "7468",
            "GIZ4_AIS5_G1": "7352",
            "GIZ4_AIS5_S3": "7401",
            "GIZ4_ISS2_S1": "7359",
            "GIZ4_ISS3_S1": "7319",
            **{name: str(number) for name, number in ROUND_5_NON_TECHNICAL_GROUPS.items()},
        },
    },
]

SELECTED_PROFILES = [p for p in PROFILES if lms_session.track_is_selected(p["track"])]

# =========================
# ACTIVE PROFILE STATE
# =========================
_PROFILE = {}

def _p(key):
    return _PROFILE[key]


# =========================
# DEBUG HELPERS
# =========================
def dbg(msg: str):
    if DEBUG:
        print(f"[DEBUG] {msg}")


def normalize_group_name_from_filename(path: str) -> str:
    fname = os.path.basename(path)
    group_name = os.path.splitext(fname)[0]
    if group_name.endswith("_sessions"):
        group_name = group_name[:-9]
    return group_name.strip()


def inspect_csv_inventory():
    CSV_DIR = _p("CSV_DIR")
    CSV_GLOB = os.path.join(CSV_DIR, "*.csv")
    GROUP_TO_NUM = _p("GROUP_TO_NUM")

    csv_files = sorted(glob.glob(CSV_GLOB))
    print("\n" + "=" * 100)
    print("🔎 CSV INVENTORY DEBUG")
    print("=" * 100)
    print(f"CSV_DIR  : {CSV_DIR}")
    print(f"CSV_GLOB : {CSV_GLOB}")
    print(f"Found raw CSV files: {len(csv_files)}")

    if not csv_files:
        print("⚠️ No CSV files found at all.")
        return [], [], []

    mapped = []
    unmapped = []
    invalid_num = []

    for p in csv_files:
        group_name = normalize_group_name_from_filename(p)
        if group_name not in GROUP_TO_NUM:
            unmapped.append((p, group_name))
            print(f"❌ UNMAPPED   | file={os.path.basename(p)} | normalized={group_name}")
            continue

        num_group = GROUP_TO_NUM.get(group_name)
        if not num_group or str(num_group) == "0":
            invalid_num.append((p, group_name))
            print(f"⚠️ INVALID MAP| file={os.path.basename(p)} | normalized={group_name} | num={num_group}")
            continue

        mapped.append((p, group_name, num_group))
        print(f"✅ MAPPED     | file={os.path.basename(p)} | normalized={group_name} | num={num_group}")

    print("-" * 100)
    print(f"✅ mapped files   : {len(mapped)}")
    print(f"❌ unmapped files : {len(unmapped)}")
    print(f"⚠️ invalid nums   : {len(invalid_num)}")
    print("=" * 100 + "\n")

    return csv_files, mapped, unmapped


# =========================
# UTIL
# =========================
def wait_dom_ready(page):
    page.wait_for_load_state("domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=SHORT_TIMEOUT_MS)
    except Exception:
        pass


def dismiss_popups(page):
    for _ in range(3):
        try:
            alert = page.locator(".alert").first
            if alert.count() > 0 and alert.is_visible(timeout=300):
                close_btn = alert.locator(
                    "button.close, .close, [data-dismiss='alert'], [aria-label='Close']"
                ).first
                if close_btn.count() > 0 and close_btn.is_visible(timeout=300):
                    close_btn.click()
                    page.wait_for_timeout(150)
        except Exception:
            pass

        try:
            dialog = page.locator(
                "[role='dialog'], .modal.show, .moodle-dialogue, .swal2-container"
            ).first
            if dialog.count() > 0 and dialog.is_visible(timeout=300):
                btn = dialog.locator(
                    "button:has-text('OK'), button:has-text('Close'), button:has-text('Cancel'), "
                    "button:has-text('Dismiss'), button:has-text('Got it'), "
                    "[role='button']:has-text('OK'), [role='button']:has-text('Close')"
                ).first
                if btn.count() > 0 and btn.is_visible(timeout=300):
                    btn.click()
                    page.wait_for_timeout(150)
        except Exception:
            pass

        try:
            page.keyboard.press("Escape")
        except Exception:
            pass


def dismiss_chrome_password_popup(page):
    """يغلق الـ popup بتاع Chrome اللي بيقول 'Change your password' بعد الـ login."""
    lms_session.dismiss_chrome_password_popup(page)


def normalize_text(s: str) -> str:
    return " ".join((s or "").split()).strip().lower()


# =========================
# DATE / TITLE PARSING
# =========================
_MONTHS = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}


def parse_csv_date(dtxt: str) -> date:
    return datetime.strptime(dtxt.strip(), "%a %d %b %Y").date()


def extract_md_from_title(title: str):
    t = " ".join((title or "").split())
    m = re.search(r"\|\s*(\d{1,2})\s*-\s*([A-Za-z]{3,9})\s*\|", t)
    if not m:
        return None, None
    dd = int(m.group(1))
    mon = m.group(2).lower().replace(".", "")
    mon_num = _MONTHS.get(mon)
    if not mon_num:
        return None, None
    return dd, mon_num


def extract_time_range_from_title(title: str):
    m = re.search(
        r"(\d{1,2}(?::\d{2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{2})?\s*[ap]m)",
        title or "",
        re.I
    )
    if not m:
        return None, None

    def to_24(t: str) -> str:
        t = t.strip().lower()
        mm = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$", t, re.I)
        if not mm:
            return None
        h = int(mm.group(1))
        minute = int(mm.group(2) or "00")
        ap = mm.group(3).lower()
        if ap == "pm" and h != 12:
            h += 12
        if ap == "am" and h == 12:
            h = 0
        return f"{h:02d}:{minute:02d}"

    start = to_24(m.group(1))
    end = to_24(m.group(2))
    if end == "00:00":
        end = "23:59"
    return start, end


def build_target_dates_with_rollover(rows_csv, start_year_for_december=None):
    today = datetime.now().date()

    explicit_year = None
    for item in rows_csv:
        if item.get("date_text"):
            try:
                explicit_year = parse_csv_date(item["date_text"]).year
                break
            except Exception:
                pass

    if start_year_for_december is not None:
        base_year = start_year_for_december
    elif explicit_year is not None:
        base_year = explicit_year
    else:
        first_month = None
        for item in rows_csv:
            if item.get("date_text"):
                try:
                    first_month = parse_csv_date(item["date_text"]).month
                    break
                except Exception:
                    pass
            else:
                dd, mm = extract_md_from_title(item.get("title", ""))
                if dd and mm:
                    first_month = mm
                    break

        if first_month is None:
            raise ValueError("Could not infer first month/year from CSV rows")

        if first_month > today.month:
            base_year = today.year - 1
        else:
            base_year = today.year

    result = []
    current_year = base_year
    prev_month = None

    for idx, item in enumerate(rows_csv, start=1):
        if item.get("date_text"):
            d = parse_csv_date(item["date_text"])
            result.append(d)
            prev_month = d.month
            current_year = d.year
            continue

        dd, mm = extract_md_from_title(item.get("title", ""))
        if not dd or not mm:
            raise ValueError(f"Cannot parse date from title at row {idx}: {item.get('title', '')}")

        if prev_month is not None and mm < prev_month:
            current_year += 1

        d = date(current_year, mm, dd)
        result.append(d)
        prev_month = mm

    return result


# =========================
# CSV HELPERS
# =========================
def read_csv_rows(path):
    out = []
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f)
        fieldnames = [x.strip().lower() for x in (reader.fieldnames or [])]

        if "title" in fieldnames:
            for row in reader:
                out.append({
                    "session_url": (row.get("sessionUrl") or row.get("sessionurl") or "").strip(),
                    "date_text": (row.get("date") or "").strip(),
                    "title": (row.get("title") or "").strip(),
                })
            dbg(f"read_csv_rows(dict) -> {os.path.basename(path)} rows={len(out)}")
            return out

    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f2:
        r2 = csv.reader(f2)
        rows = list(r2)
        if not rows:
            return []

        header = [c.strip().lower() for c in rows[0]]
        title_col = header.index("title") if "title" in header else 0
        session_url_col = header.index("sessionurl") if "sessionurl" in header else None

        for row in rows[1:]:
            if not row or title_col >= len(row):
                continue
            title = (row[title_col] or "").strip()
            if not title:
                continue
            session_url = ""
            if session_url_col is not None and session_url_col < len(row):
                session_url = (row[session_url_col] or "").strip()
            out.append({
                "session_url": session_url,
                "date_text": "",
                "title": title,
            })

        dbg(f"read_csv_rows(list) -> {os.path.basename(path)} rows={len(out)}")
        return out


# =========================
# SELECT HELPERS
# =========================
def _try_select_option(select_locator, value_str: str, label_str: str = None) -> bool:
    try:
        select_locator.select_option(value=value_str)
        return True
    except Exception:
        pass
    if label_str:
        try:
            select_locator.select_option(label=label_str)
            return True
        except Exception:
            pass
    try:
        select_locator.select_option(value_str)
        return True
    except Exception:
        return False


# =========================
# LOGIN
# =========================
def ensure_logged_in(page, email: str, password: str):
    lms_session.ensure_account(
        page,
        email,
        password,
        default_timeout_ms=DEFAULT_TIMEOUT_MS,
        short_timeout_ms=SHORT_TIMEOUT_MS,
    )
    dismiss_popups(page)
    dismiss_chrome_password_popup(page)


# =========================
# LMS TABLE HELPERS
# =========================
def extract_date_from_row_text(txt: str):
    t = " ".join((txt or "").split())
    t = re.sub(r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+", "", t, flags=re.I)
    m = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b", t)
    if not m:
        return None
    dd = int(m.group(1))
    mon = m.group(2).lower().replace(".", "")
    yy = int(m.group(3))
    mon_num = _MONTHS.get(mon)
    if not mon_num:
        return None
    return date(yy, mon_num, dd)


def extract_title_from_row_text(row_text: str) -> str:
    # A row reads "Fri 17 July 2026 2PM - 5PM Group: CAI5_AIS4_S7 <description>":
    # the description is what the CSV title is compared with, so the date, the
    # time and the group cell are all stripped, not only the date.
    txt = " ".join((row_text or "").split())
    m = re.search(r"Group:\s*[A-Za-z0-9_]+\s+(.*)$", txt, flags=re.I)
    if m:
        txt = m.group(1)
    else:
        txt = re.sub(r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+", "", txt, flags=re.I)
        txt = re.sub(r"^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}\s*", "", txt, flags=re.I)
        txt = re.sub(
            r"^\d{1,2}(?::\d{2})?\s*[AP]M\s*-\s*\d{1,2}(?::\d{2})?\s*[AP]M\s*", "", txt, flags=re.I
        )
        txt = re.sub(r"^(All students|Common session)\s*", "", txt, flags=re.I)
    junk_patterns = [
        r"Edit Session", r"Delete", r"Delete Session",
        r"Change attendance", r"Take attendance", r"Actions",
    ]
    for p in junk_patterns:
        txt = re.sub(p, "", txt, flags=re.I)
    return " ".join(txt.split()).strip()


def extract_time_range_from_text(text: str):
    return extract_time_range_from_title(text or "")


def is_same_session_exact(lms_session, target_date, csv_title, start24, end24):
    if lms_session["date_obj"] != target_date:
        return False
    lms_start, lms_end = extract_time_range_from_text(lms_session.get("row_text", ""))
    if lms_start != start24 or lms_end != end24:
        return False
    return lms_session["title_norm"] == normalize_text(csv_title)


def find_exact_match(lms_sessions, target_date, csv_title, start24, end24):
    for s in lms_sessions:
        if is_same_session_exact(s, target_date, csv_title, start24, end24):
            return s
    return None


def choose_lms_session(lms_sessions, target_date, start24, end24, claimed):
    """Picks the LMS session a CSV row should edit.

    Returns (session, how) with how one of:
      "time"     same date and time, not yet paired with another CSV row
      "conflict" same date and time, but already paired with another CSV row
                 in this run (nothing is edited or created for such a row)
      "date"     same date only, not yet paired (the time is corrected by the edit)
      "none"     nothing on that date is free: the session has to be created
    A session paired with one CSV row (matched, edited or created) is never
    handed to a second row, so two sessions on the same day stay two sessions.
    """
    same_time_claimed = None
    for s in lms_sessions:
        if s["date_obj"] != target_date:
            continue
        lms_start, lms_end = extract_time_range_from_text(s.get("row_text", ""))
        if lms_start == start24 and lms_end == end24:
            if s["key"] in claimed:
                same_time_claimed = same_time_claimed or s
                continue
            return s, "time"
    if same_time_claimed:
        return same_time_claimed, "conflict"
    for s in lms_sessions:
        if s["date_obj"] == target_date and s["key"] not in claimed:
            return s, "date"
    return None, "none"


def group_round(group_name: str) -> str:
    m = re.match(r"^[A-Za-z]{3,4}([45])", str(group_name or "").strip())
    return m.group(1) if m else ""


def build_target_url(num_group: int, group_name: str = "") -> str:
    round_number = group_round(group_name) or LMS_ROUND
    COURSE_MODULE_ID = (
        COURSE_MODULE_ID_OVERRIDE
        or (_p("ROUND_5_COURSE_MODULE_ID") if round_number == "5" else _p("COURSE_MODULE_ID"))
    )
    return (
        f"https://lms.wavz.com.eg:8443/mod/attendance/manage.php"
        f"?id={COURSE_MODULE_ID}&view={VIEW}&group={num_group}"
    )


def goto_table(page, target_url: str):
    page.goto(target_url)
    wait_dom_ready(page)
    dismiss_popups(page)
    page.wait_for_selector("body", timeout=DEFAULT_TIMEOUT_MS)

    possible_selectors = [
        "table.generaltable",
        "button:has-text('Add session')",
        "input[value*='Add session']",
        "a:has-text('Add session')",
        "#region-main",
        "main",
    ]
    loaded = False
    for sel in possible_selectors:
        try:
            page.locator(sel).first.wait_for(state="visible", timeout=4000)
            loaded = True
            dbg(f"goto_table loaded with selector: {sel}")
            break
        except Exception:
            pass

    if not loaded:
        raise RuntimeError(f"Attendance page did not load correctly: {page.url}")


def build_lms_sessions(page):
    # The whole table is read in one page call (see lms_session.parse_sessions_table).
    out = []
    for row in lms_session.parse_sessions_table(page):
        txt = " ".join(row["text"].split())
        lowered = txt.lower()

        if not txt:
            continue
        if "no sessions" in lowered or "nothing to display" in lowered or "no data available" in lowered:
            continue

        d = extract_date_from_row_text(txt)
        if not d:
            continue

        title = extract_title_from_row_text(txt)
        out.append({
            "idx_1based": row["index"] + 1,
            "date_obj": d,
            "title": title,
            "title_norm": normalize_text(title),
            "row_text": txt[:500],
            "attendance_taken": row["attendance_taken"],
            "session_id": row["session_id"],
            "edit_href": row["edit_href"],
            # Stable identity across table reloads (row numbers shift when a
            # session is created); the text fallback is for rows without links.
            "key": row["session_id"] or f"row:{row['index']}:{txt[:120]}",
        })

    dbg(f"build_lms_sessions -> parsed_rows={len(out)}")
    return out


def click_edit_by_index(page, idx_1based: int):
    loc = page.locator(f"(//a[@aria-label='Edit Session'])[{idx_1based}]")
    loc.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    loc.scroll_into_view_if_needed()

    last = None
    for _ in range(3):
        try:
            loc.click(timeout=6000)
            last = None
            break
        except Exception as e:
            last = e
            page.wait_for_timeout(300)
            try:
                loc.click(timeout=6000, force=True)
                last = None
                break
            except Exception as e2:
                last = e2
                page.wait_for_timeout(300)

    if last:
        raise RuntimeError(f"Click Edit failed idx={idx_1based}: {last}")

    page.get_by_role("button", name=re.compile("save changes", re.I)).wait_for(timeout=DEFAULT_TIMEOUT_MS)
    dismiss_popups(page)


def open_edit_form(page, candidate: dict, target_url: str):
    """Opens one session's edit form through its own link (sessionid in the
    URL), so the right session is edited even when row numbers shifted."""
    href = candidate.get("edit_href")
    if href:
        page.goto(href)
        wait_dom_ready(page)
        dismiss_popups(page)
        page.get_by_role("button", name=re.compile("save changes", re.I)).wait_for(timeout=DEFAULT_TIMEOUT_MS)
        return

    # No edit link was captured for this row: fall back to the table icon.
    goto_table(page, target_url)
    click_edit_by_index(page, candidate["idx_1based"])


# =========================
# EDIT / ADD PAGE HELPERS
# =========================
def set_description_tinymce(page, text: str):
    page.locator(".tox-tinymce").first.wait_for(timeout=DEFAULT_TIMEOUT_MS)

    iframe_sel = "iframe.tox-edit-area__iframe"
    if page.locator(iframe_sel).count() == 0:
        for sel in ["iframe[id$='_ifr']", "iframe[title*='Rich text']", "iframe"]:
            if page.locator(sel).count() > 0:
                iframe_sel = sel
                break

    page.locator(iframe_sel).first.wait_for(timeout=DEFAULT_TIMEOUT_MS)
    frame = page.frame_locator(iframe_sel)
    body = frame.locator("body")
    body.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    body.click()
    body.press("Control+A")
    body.type(text, delay=10)


def set_date_dropdowns(page, target_date: date):
    day_sel = page.locator("#id_sessiondate_day").first
    mon_sel = page.locator("#id_sessiondate_month").first
    yr_sel = page.locator("#id_sessiondate_year").first

    day_sel.wait_for(timeout=DEFAULT_TIMEOUT_MS)
    mon_sel.wait_for(timeout=DEFAULT_TIMEOUT_MS)
    yr_sel.wait_for(timeout=DEFAULT_TIMEOUT_MS)

    day = str(target_date.day)
    month_label = target_date.strftime("%B")
    year = str(target_date.year)

    try:
        mon_sel.select_option(label=month_label)
    except Exception:
        if not _try_select_option(mon_sel, str(target_date.month), month_label):
            raise RuntimeError(f"Failed to select month {month_label}")

    page.wait_for_timeout(150)
    if not _try_select_option(day_sel, day, day):
        raise RuntimeError(f"Failed to select day {day}")
    page.wait_for_timeout(150)
    if not _try_select_option(yr_sel, year, year):
        raise RuntimeError(f"Failed to select year {year}")


def set_time_dropdowns(page, start24: str, end24: str):
    if not start24 or not end24:
        return

    sh, sm = map(int, start24.split(":"))
    eh, em = map(int, end24.split(":"))

    start_hour_sel = page.locator("select[name='sestime[starthour]']").first
    start_min_sel = page.locator("select[name='sestime[startminute]']").first
    end_hour_sel = page.locator("select[name='sestime[endhour]']").first
    end_min_sel = page.locator("select[name='sestime[endminute]']").first

    start_hour_sel.wait_for(timeout=DEFAULT_TIMEOUT_MS)
    start_min_sel.wait_for(timeout=DEFAULT_TIMEOUT_MS)
    end_hour_sel.wait_for(timeout=DEFAULT_TIMEOUT_MS)
    end_min_sel.wait_for(timeout=DEFAULT_TIMEOUT_MS)

    def pick_value(sel, num: int, label_hint: str = None):
        expected_a = f"{num:02d}"
        expected_b = str(num)
        for _ in range(3):
            _try_select_option(sel, expected_a, label_hint or expected_a)
            _try_select_option(sel, expected_b, label_hint or expected_b)
            page.wait_for_timeout(120)
            try:
                cur = sel.input_value(timeout=2000).strip()
                if cur in {expected_a, expected_b}:
                    return
            except Exception:
                pass
            page.wait_for_timeout(200)
        raise RuntimeError(f"Select verify failed (wanted {num})")

    pick_value(start_hour_sel, sh)
    pick_value(start_min_sel, sm)
    pick_value(end_hour_sel, eh)
    pick_value(end_min_sel, em)


def save_changes(page):
    save_btn = page.get_by_role("button", name=re.compile("save changes", re.I)).first
    save_btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    save_btn.scroll_into_view_if_needed()

    for _ in range(25):
        try:
            if save_btn.is_enabled():
                break
        except Exception:
            pass
        page.wait_for_timeout(150)

    try:
        with page.expect_navigation(wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT_MS):
            save_btn.click(timeout=DEFAULT_TIMEOUT_MS)
    except Exception:
        save_btn.click(timeout=DEFAULT_TIMEOUT_MS)

    wait_dom_ready(page)
    dismiss_popups(page)

    try:
        page.wait_for_selector("table.generaltable tbody tr", timeout=DEFAULT_TIMEOUT_MS)
    except Exception:
        pass


def set_group_for_add_session(page, group_name: str):
    GROUP_OPTION_VALUES = _p("GROUP_OPTION_VALUES")

    if group_name not in GROUP_OPTION_VALUES:
        raise RuntimeError(
            f"Group '{group_name}' is not available in GROUP_OPTION_VALUES. "
            f"Add it first before trying to create sessions for that group."
        )

    group_value = GROUP_OPTION_VALUES[group_name]
    group_select = page.locator("select[name='groups[]'], #id_groups").first
    group_select.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)

    try:
        group_select.select_option(value=group_value)
    except Exception:
        group_select.select_option(label=group_name)

    selected = group_select.evaluate(
        "el => Array.from(el.selectedOptions).map(o => o.value)"
    )
    if group_value not in selected:
        raise RuntimeError(f"Failed to select group '{group_name}' with value '{group_value}'")

    dbg(f"Selected add-session group -> {group_name} ({group_value})")
    page.wait_for_timeout(300)


def goto_add_session_page(page, target_url: str):
    goto_table(page, target_url)

    add_btn = page.locator(
        "button:has-text('Add session'), input[value*='Add session'], a:has-text('Add session')"
    ).first
    add_btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    add_btn.scroll_into_view_if_needed()
    add_btn.click()

    wait_dom_ready(page)
    dismiss_popups(page)

    try:
        expand_all = page.locator("button, a").filter(
            has_text=re.compile(r"expand all", re.I)
        ).first
        if expand_all.count() > 0 and expand_all.is_visible(timeout=3000):
            expand_all.scroll_into_view_if_needed()
            expand_all.click()
            page.wait_for_timeout(700)
    except Exception:
        pass

    page.locator("select[name='groups[]'], #id_groups").first.wait_for(
        state="visible",
        timeout=DEFAULT_TIMEOUT_MS
    )


def submit_add_session(page):
    add_btn = page.get_by_role("button", name=re.compile(r"^add$", re.I)).first

    try:
        add_btn.wait_for(state="visible", timeout=3000)
    except Exception:
        add_btn = page.locator(
            "input[type='submit'][value*='Add'], button[type='submit']"
        ).first
        add_btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)

    add_btn.scroll_into_view_if_needed()

    try:
        with page.expect_navigation(wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT_MS):
            add_btn.click()
    except Exception:
        add_btn.click()

    wait_dom_ready(page)
    dismiss_popups(page)

    try:
        page.wait_for_selector("table.generaltable, #region-main, main", timeout=DEFAULT_TIMEOUT_MS)
    except Exception:
        pass


def add_one_session(page, target_url: str, group_name: str, target_date: date, title: str, start24: str, end24: str):
    goto_add_session_page(page, target_url)
    set_group_for_add_session(page, group_name)
    set_date_dropdowns(page, target_date)
    set_time_dropdowns(page, start24, end24)
    set_description_tinymce(page, title)

    print(f"➕ Adding session | group={group_name} | date={target_date.isoformat()} | time={start24}-{end24}")
    submit_add_session(page)
    print("✅ Session added.")
    page.wait_for_timeout(INTER_SESSION_PAUSE_MS)


def add_one_session_with_retry(page, target_url: str, group_name: str, target_date: date, title: str, start24: str, end24: str, retries: int = 2):
    last_error = None

    for attempt in range(1, retries + 2):
        try:
            print(f"🔁 Create attempt {attempt} for {group_name} | {target_date.isoformat()} | {start24}-{end24}")
            add_one_session(page, target_url, group_name, target_date, title, start24, end24)
            return True
        except Exception as e:
            last_error = e
            print(f"❌ Create attempt {attempt} failed: {e}")
            try:
                page.goto(target_url)
                wait_dom_ready(page)
                dismiss_popups(page)
            except Exception:
                pass
            page.wait_for_timeout(1200)

    raise RuntimeError(f"all create attempts failed: {last_error}")


# =========================
# REPORT HELPERS
# =========================
def mark_unmatched(unmatched, csv_path, row_num, item, reason):
    unmatched.append({
        "csv_file": os.path.basename(csv_path),
        "csv_row": row_num,
        "title": str(item.get("title", ""))[:180],
        "reason": reason,
    })


def print_unmatched_report(unmatched):
    if not unmatched:
        print("\n✅ No unmatched CSV rows. All possible rows were processed successfully.")
        return

    print("\n" + "#" * 110)
    print("⚠️ UNMATCHED CSV ROWS REPORT")
    print("#" * 110)

    grouped = {}
    for x in unmatched:
        grouped.setdefault(x["csv_file"], []).append(x)

    for csv_file, items in grouped.items():
        print(f"\n📄 CSV FILE: {csv_file}")
        for it in items:
            print(f"- row {it['csv_row']}: reason={it['reason']} | title={it['title']}")

    print("\n" + "#" * 110)


# =========================
# PROCESS ONE FILE
# =========================
def verify_after_change(page, target_url, action, target_date, csv_title, start24, end24,
                        claimed, unmatched, csv_path, csv_idx, item, stats):
    """Reloads the table after an edit/creation and checks the session is there
    with the expected date, time and title. Returns the fresh session list."""
    goto_table(page, target_url)
    sessions = build_lms_sessions(page)

    found = find_exact_match(sessions, target_date, csv_title, start24, end24)
    if found:
        claimed.add(found["key"])
        stats["edited" if action == "edit" else "created"] += 1
        print(f"✅ Verified on LMS row {found['idx_1based']}: session {'edited' if action == 'edit' else 'created'}.")
    else:
        stats["failed"] += 1
        print(
            f"❌ Verification failed: no LMS session with date {target_date.isoformat()}, "
            f"time {start24}-{end24} and this title after the {action}."
        )
        mark_unmatched(
            unmatched, csv_path, csv_idx, item,
            f"verification failed after {action}: session not found with the expected date/time/title",
        )
    return sessions


def process_one_csv(page, csv_path: str, unmatched):
    GROUP_TO_NUM = _p("GROUP_TO_NUM")

    fname = os.path.basename(csv_path)
    group_name = normalize_group_name_from_filename(csv_path)
    dbg(f"process_one_csv start -> file={fname} group_name={group_name}")

    if group_name not in GROUP_TO_NUM:
        print(f"⚠️ SKIP: {fname} (no mapping for '{group_name}' in GROUP_TO_NUM)")
        mark_unmatched(unmatched, csv_path, 0, {"title": ""}, f"group '{group_name}' missing in GROUP_TO_NUM")
        return

    num_group = GROUP_TO_NUM[group_name]
    if not num_group or str(num_group) == "0":
        print(f"⚠️ SKIP: {fname} (GROUP_TO_NUM for '{group_name}' is missing/0)")
        mark_unmatched(unmatched, csv_path, 0, {"title": ""}, f"group '{group_name}' has no valid NumGroup in GROUP_TO_NUM")
        return

    target_url = build_target_url(num_group, group_name)
    rows_csv = read_csv_rows(csv_path)
    if not rows_csv:
        print(f"⚠️ SKIP empty CSV: {fname}")
        return

    print("\n" + "=" * 100)
    print(f"🧩 GROUP: {group_name} | Num group: {num_group}")
    print(f"🔗 URL: {target_url}")
    print(f"📄 CSV rows: {len(rows_csv)}")
    print("=" * 100)

    try:
        target_dates = build_target_dates_with_rollover(rows_csv)
    except Exception as e:
        raise RuntimeError(f"Failed building target dates from CSV: {e}")

    group_started = datetime.now()

    # One page load and one read of the whole table per group; every CSV row
    # is compared against this list. The table is read again only after an
    # edit or a creation, to verify it and to keep the list current.
    goto_table(page, target_url)
    lms_sessions = build_lms_sessions(page)
    print(f"📌 LMS visible REAL session rows: {len(lms_sessions)}")

    claimed = set()  # LMS sessions already paired with a CSV row in this run
    planned_creates = set()  # DRY_RUN only: creations that a real run would have done by now
    stats = {"correct": 0, "same_title": 0, "taken": 0, "conflict": 0, "edited": 0, "created": 0, "failed": 0}

    for csv_idx, item in enumerate(rows_csv, start=1):
        try:
            csv_title = item.get("title", "").strip()
            target_date = target_dates[csv_idx - 1]

            start24, end24 = extract_time_range_from_title(csv_title)
            if not start24 or not end24:
                stats["failed"] += 1
                mark_unmatched(unmatched, csv_path, csv_idx, item, "could not parse time from title")
                continue

            planned_key = (target_date, start24, end24, normalize_text(csv_title))
            exact = find_exact_match(lms_sessions, target_date, csv_title, start24, end24)
            if exact or planned_key in planned_creates:
                if exact:
                    claimed.add(exact["key"])
                stats["correct"] += 1
                where = f"LMS row {exact['idx_1based']}" if exact else "a session planned above (DRY_RUN)"
                dbg(
                    f"[{group_name}] CSV row {csv_idx}: already correct at {where} "
                    f"| {target_date.isoformat()} | {start24}-{end24}"
                )
                continue

            print("\n" + "-" * 80)
            print(f"[{group_name}] CSV row {csv_idx}/{len(rows_csv)}")
            print(f"🎯 target_date: {target_date.isoformat()}")
            print(f"📝 csv_title: {csv_title[:140]}")
            print(f"⏰ time: {start24} -> {end24}")

            candidate, how = choose_lms_session(lms_sessions, target_date, start24, end24, claimed)
            if how == "conflict":
                stats["conflict"] += 1
                print(
                    f"⚠️ LMS row {candidate['idx_1based']} at this date/time is already paired with "
                    f"another CSV row -> nothing changed (check the titles CSV for a stale row)"
                )
                mark_unmatched(
                    unmatched, csv_path, csv_idx, item,
                    "another CSV row already matched the LMS session at this date/time; nothing changed",
                )
                continue

            if candidate:
                claimed.add(candidate["key"])
                if candidate["title_norm"] == normalize_text(csv_title):
                    stats["same_title"] += 1
                    print(f"⏭️ Same title already exists on LMS row {candidate['idx_1based']} -> skip edit")
                    continue

                # A session that already has attendance (the green "Change
                # attendance" arrow) is left exactly as it is.
                if candidate.get("attendance_taken"):
                    stats["taken"] += 1
                    print(
                        f"⏭️ Attendance already taken on LMS row {candidate['idx_1based']} "
                        f"| current='{candidate.get('title', '')[:100]}' -> edit skipped"
                    )
                    mark_unmatched(unmatched, csv_path, csv_idx, item, "attendance already taken on LMS; edit skipped")
                    continue

                print(
                    f"✏️ Found editable session on LMS row {candidate['idx_1based']} "
                    f"| current='{candidate.get('title', '')[:100]}'"
                )
                if DRY_RUN:
                    print("🧪 DRY_RUN: this session would be edited.")
                    stats["edited"] += 1
                    continue

                open_edit_form(page, candidate, target_url)
                set_description_tinymce(page, csv_title)
                set_date_dropdowns(page, target_date)
                set_time_dropdowns(page, start24, end24)

                print("💾 Saving edit...")
                save_changes(page)
                lms_sessions = verify_after_change(
                    page, target_url, "edit", target_date, csv_title, start24, end24,
                    claimed, unmatched, csv_path, csv_idx, item, stats,
                )
                page.wait_for_timeout(INTER_SESSION_PAUSE_MS)
            else:
                print(f"➕ Session not found on LMS. Creating one | date={target_date.isoformat()} | time={start24}-{end24}")
                if DRY_RUN:
                    print("🧪 DRY_RUN: this session would be created.")
                    stats["created"] += 1
                    planned_creates.add(planned_key)
                    continue

                add_one_session_with_retry(
                    page=page,
                    target_url=target_url,
                    group_name=group_name,
                    target_date=target_date,
                    title=csv_title,
                    start24=start24,
                    end24=end24,
                    retries=2,
                )
                lms_sessions = verify_after_change(
                    page, target_url, "create", target_date, csv_title, start24, end24,
                    claimed, unmatched, csv_path, csv_idx, item, stats,
                )
                page.wait_for_timeout(INTER_SESSION_PAUSE_MS)

        except Exception as e:
            stats["failed"] += 1
            print(f"❌ Failed on CSV row {csv_idx}: {e}")
            mark_unmatched(unmatched, csv_path, csv_idx, item, f"sync failed: {e}")
            # The page may be anywhere after a failure: reload the table so the
            # next CSV rows are compared with what is really on the LMS.
            try:
                goto_table(page, target_url)
                lms_sessions = build_lms_sessions(page)
            except Exception as reload_error:
                print(f"❌ Could not reload the sessions table, stopping this group: {reload_error}")
                for later_idx in range(csv_idx + 1, len(rows_csv) + 1):
                    mark_unmatched(
                        unmatched, csv_path, later_idx, rows_csv[later_idx - 1],
                        "not checked: the sessions table could not be reloaded",
                    )
                break

    print("\n" + "#" * 90)
    print(
        f"✅ DONE GROUP: {group_name} | already correct={stats['correct']} | same title={stats['same_title']} | "
        f"edited={stats['edited']} | created={stats['created']} | "
        f"skipped (attendance taken)={stats['taken']} | conflicts={stats['conflict']} | failed={stats['failed']} "
        f"| {(datetime.now() - group_started).total_seconds():.1f}s"
    )
    if DRY_RUN and (stats["edited"] or stats["created"]):
        print("🧪 DRY_RUN: nothing was changed on the LMS.")
    print("#" * 90)


# =========================
# RUN ONE PROFILE
# =========================
def run_profile(page, profile: dict, all_unmatched: list):
    global _PROFILE
    _PROFILE = profile

    print("\n" + "█" * 110)
    print(f"🚀 STARTING PROFILE: {profile['name']}  |  COURSE_MODULE_ID={profile['COURSE_MODULE_ID']}")
    print("█" * 110)

    CSV_DIR = profile["CSV_DIR"]

    if not os.path.exists(CSV_DIR):
        print(f"❌ Folder not found: {CSV_DIR}")
        return

    raw_csv_files, mapped_rows, unmapped_rows = inspect_csv_inventory()

    if not raw_csv_files:
        return

    if unmapped_rows:
        print("⚠️ Some CSV files were found but are NOT in GROUP_TO_NUM.")
        print("   They will be skipped until you add their mapping.")
        for _, group_name in unmapped_rows:
            print(f"   - Missing mapping for: {group_name}")

    csv_files = raw_csv_files
    if LMS_ROUND:
        csv_files = [
            csv_path for csv_path in csv_files
            if re.match(
                r"^[A-Za-z]{3,4}" + re.escape(LMS_ROUND),
                normalize_group_name_from_filename(csv_path),
            )
        ]
    if ONLY_GROUPS:
        csv_files = [
            csv_path for csv_path in raw_csv_files
            if normalize_group_name_from_filename(csv_path) in ONLY_GROUPS
        ]
        print(f"🎯 Group filter active for profile {profile['name']}: {', '.join(sorted(ONLY_GROUPS))}")

    if not csv_files:
        print("❌ No CSV files matched the selected group filter.")
        return

    print(f"📂 Total CSV files discovered: {len(csv_files)}")
    for p in csv_files:
        print(" -", os.path.basename(p))

    for csv_path in csv_files:
        try:
            process_one_csv(page, csv_path, all_unmatched)
        except Exception as e:
            print(f"❌ Fatal error while processing {os.path.basename(csv_path)}: {e}")
            mark_unmatched(all_unmatched, csv_path, 0, {"title": ""}, f"fatal file-level error: {e}")

    print("\n" + "█" * 110)
    print(f"✅ DONE PROFILE: {profile['name']}")
    print("█" * 110)


# =========================
# MAIN
# =========================
def main():
    all_unmatched = []

    print(f"🎛️ Track: {lms_session.track_label(LMS_TRACK)}")
    if not SELECTED_PROFILES:
        print("❌ No profile matches the selected track.")
        return

    with sync_playwright() as p:
        context = None
        page = None
        current_email = None

        try:
            for profile in SELECTED_PROFILES:
                email, password = lms_session.account_for_track(profile["track"])

                if context is not None and email != current_email:
                    # Different LMS account -> close this session and open the
                    # Chrome profile that belongs to the other account.
                    context.close()
                    context = None
                    page = None

                if context is None:
                    user_data_dir = lms_session.user_data_dir_for(email)
                    lms_session.harden_chrome_profile(user_data_dir)
                    context = p.chromium.launch_persistent_context(
                        user_data_dir=user_data_dir,
                        headless=False,
                        channel="chrome",
                        args=lms_session.CHROME_LAUNCH_ARGS,
                    )
                    page = context.new_page()
                    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
                    current_email = email
                    ensure_logged_in(page, email, password)

                run_profile(page, profile, all_unmatched)

            print_unmatched_report(all_unmatched)
        finally:
            if context is not None:
                context.close()


if __name__ == "__main__":
    main()
