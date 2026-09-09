import os
import re
import glob
import csv
from datetime import date, datetime
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()

# =========================
# CONFIG
# =========================
LOGIN_URL = "https://lms.wavz.com.eg:8443/login/index.php"
VIEW = 4

EMAIL = os.getenv("LMS_EMAIL", "").strip()
PASSWORD = os.getenv("LMS_PASSWORD", "").strip()

BASE_PROFILE_DIR = r"C:\Users\mohab\Desktop\pw-profile"
safe_email = re.sub(r"[^a-zA-Z0-9]+", "_", (EMAIL or "default").lower())
USER_DATA_DIR = rf"{BASE_PROFILE_DIR}\{safe_email}"

DEFAULT_TIMEOUT_MS = int(os.getenv("DEFAULT_TIMEOUT_MS", "25000"))
SHORT_TIMEOUT_MS = int(os.getenv("SHORT_TIMEOUT_MS", "6000"))
INTER_SESSION_PAUSE_MS = int(os.getenv("INTER_SESSION_PAUSE_MS", "1500"))

DRY_RUN = os.getenv("DRY_RUN", "false").strip().lower() == "true"

_start_from_raw = os.getenv("START_FROM_DATE", "").strip()
GLOBAL_START_FROM_DATE: date | None = (
    date.fromisoformat(_start_from_raw) if _start_from_raw else None
)

# Global report log
SESSION_LOG: list[dict] = []

ONLY_GROUPS = {}

# =========================
# PROFILES
# =========================
PROFILES = [
    {
        "name": "Technical",
        "COURSE_MODULE_ID": 2971,
        "EXPORTS_BASE_DIR": r"C:\Users\mohab\Desktop\eyouth-Attendence\exports\Technical groups",
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
        },
    },
    {
        "name": "Non-Technical",
        "COURSE_MODULE_ID": 6053,
        "EXPORTS_BASE_DIR": r"C:\Users\mohab\Desktop\eyouth-Attendence\exports\Non Technical groups",
        "GROUP_TO_NUM": {
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
        },
    },
]

# =========================
# ACTIVE PROFILE STATE
# =========================
_PROFILE = {}

def _p(key):
    return _PROFILE[key]


# =========================
# MONTHS
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
    try:
        ok_btn = page.locator(
            "button:has-text('OK'), [role='button']:has-text('OK')"
        ).first
        if ok_btn.count() > 0 and ok_btn.is_visible(timeout=3000):
            ok_btn.click()
            page.wait_for_timeout(500)
            print("🔒 Dismissed Chrome password breach popup.")
    except Exception:
        pass


def normalize_spaces(s: str) -> str:
    return " ".join((s or "").split()).strip()


def normalize_token(s: str) -> str:
    s = normalize_spaces(s).lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s


def build_target_url(num_group: int) -> str:
    COURSE_MODULE_ID = _p("COURSE_MODULE_ID")
    return (
        f"https://lms.wavz.com.eg:8443/mod/attendance/manage.php"
        f"?id={COURSE_MODULE_ID}&view={VIEW}&group={num_group}"
    )


# =========================
# LOGIN
# =========================
def ensure_logged_in(page):
    if not EMAIL or not PASSWORD:
        raise RuntimeError("Missing LMS_EMAIL / LMS_PASSWORD in .env")

    page.goto(LOGIN_URL)
    wait_dom_ready(page)
    dismiss_popups(page)

    email = page.locator("input[name='username'], input#username, input[type='email']").first
    pwd = page.locator("input[name='password'], input#password, input[type='password']").first
    login = page.locator("button[type='submit'], #loginbtn").first

    email.wait_for(timeout=DEFAULT_TIMEOUT_MS)
    pwd.wait_for(timeout=DEFAULT_TIMEOUT_MS)
    login.wait_for(timeout=DEFAULT_TIMEOUT_MS)

    email.fill(EMAIL)
    pwd.fill(PASSWORD)

    print("🔐 Clicking login...")
    login.click(no_wait_after=True)
    page.wait_for_timeout(5000)

    try:
        wait_dom_ready(page)
    except Exception:
        pass

    dismiss_popups(page)
    dismiss_chrome_password_popup(page)

    current_url = page.url.lower()
    if "login/index.php" in current_url:
        raise RuntimeError(f"Login failed. Still on login page: {page.url}")

    print(f"✅ Logged in successfully. URL: {page.url}")


# =========================
# TABLE HELPERS
# =========================
def goto_table(page, target_url: str):
    page.goto(target_url)
    wait_dom_ready(page)
    dismiss_popups(page)
    page.wait_for_selector("body", timeout=DEFAULT_TIMEOUT_MS)

    possible_selectors = ["table.generaltable", "#region-main", "main"]
    loaded = False
    for sel in possible_selectors:
        try:
            page.locator(sel).first.wait_for(state="visible", timeout=4000)
            loaded = True
            break
        except Exception:
            pass

    if not loaded:
        raise RuntimeError(f"Attendance page did not load correctly: {page.url}")


def get_session_rows(page):
    rows = page.locator("table.generaltable tbody tr")
    return rows, rows.count()


def extract_date_from_row_text(txt: str):
    t = normalize_spaces(txt)
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


def extract_group_from_row_text(txt: str):
    t = normalize_spaces(txt)
    m = re.search(r"Group:\s*([A-Z0-9_]+)", t, flags=re.I)
    if m:
        return m.group(1).strip()
    return None


def extract_session_title_from_row_text(txt: str):
    t = normalize_spaces(txt)
    m = re.search(r"Group:\s*[A-Z0-9_]+\s+(.*)$", t, flags=re.I)
    if not m:
        return ""
    tail = normalize_spaces(m.group(1))
    tail = re.sub(r"\b(Change attendance|Take attendance|Edit Session|Delete)\b", "", tail, flags=re.I)
    return normalize_spaces(tail)


def extract_session_type_from_title(session_title: str):
    t = normalize_spaces(session_title)
    left = t.split("|")[0].strip()
    if "-" in left:
        return left.split("-")[-1].strip()
    return left


def session_type_to_filename_token(session_type: str):
    t = normalize_spaces(session_type).lower()
    mapping = {
        "soft skills": "Soft_Skill",
        "soft skill": "Soft_Skill",
        "coaching": "Coaching",
        "coach": "Coaching",
        "freelancing": "Freelancing",
        "freelance": "Freelancing",
    }
    if t in mapping:
        return mapping[t]
    parts = [p.capitalize() for p in normalize_token(t).split("_") if p]
    return "_".join(parts)


def row_has_take_attendance(row) -> bool:
    try:
        loc = row.locator(
            "xpath=.//a[contains(@href,'/mod/attendance/take.php') and (@aria-label='Take attendance' or @title='Take attendance' or .//i[contains(@class,'fa-play')])]"
        ).first
        return loc.count() > 0
    except Exception:
        return False


def row_has_change_attendance(row) -> bool:
    try:
        loc = row.locator(
            "xpath=.//a[contains(@href,'/mod/attendance/take.php') and (@aria-label='Change attendance' or @title='Change attendance' or .//img[contains(@src,'redo')])]"
        ).first
        return loc.count() > 0
    except Exception:
        return False


def click_take_attendance_in_row(row):
    loc = row.locator(
        "xpath=.//a[contains(@href,'/mod/attendance/take.php') and (@aria-label='Take attendance' or @title='Take attendance' or .//i[contains(@class,'fa-play')])]"
    ).first
    loc.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    loc.scroll_into_view_if_needed()
    loc.click()


def debug_row_actions(row, row_no):
    try:
        links = row.locator("a").all()
        print(f"🔎 Row {row_no} links count = {len(links)}")
        for idx, a in enumerate(links, start=1):
            try:
                print(
                    f"   link {idx}: "
                    f"aria-label={a.get_attribute('aria-label')} | "
                    f"title={a.get_attribute('title')} | "
                    f"href={a.get_attribute('href')}"
                )
            except Exception:
                pass
    except Exception as e:
        print(f"⚠️ debug_row_actions failed on row {row_no}: {e}")


def get_csv_date_range_for_group(group_name: str) -> "tuple[date | None, date | None]":
    EXPORTS_BASE_DIR = _p("EXPORTS_BASE_DIR")
    group_dir = os.path.join(EXPORTS_BASE_DIR, group_name)
    if not os.path.isdir(group_dir):
        return None, None

    earliest = None
    latest = None
    date_re = re.compile(r"^(\d{4})_(\d{2})_(\d{2})")
    for fname in os.listdir(group_dir):
        m = date_re.match(fname)
        if not m:
            continue
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if earliest is None or d < earliest:
                earliest = d
            if latest is None or d > latest:
                latest = d
        except ValueError:
            pass

    return earliest, latest


def find_csv_for_session(group_name: str, row_date: date, session_type: str):
    EXPORTS_BASE_DIR = _p("EXPORTS_BASE_DIR")
    group_dir = os.path.join(EXPORTS_BASE_DIR, group_name)
    if not os.path.isdir(group_dir):
        raise RuntimeError(f"Group export folder not found: {group_dir}")

    date_prefix = f"{row_date.year:04d}_{row_date.month:02d}_{row_date.day:02d}"
    type_token = session_type_to_filename_token(session_type)
    candidates = sorted(glob.glob(os.path.join(group_dir, "*.csv")))
    if not candidates:
        raise RuntimeError(f"No CSV files found in group folder: {group_dir}")

    strict = []
    for p in candidates:
        name = os.path.basename(p)
        if date_prefix in name and type_token.lower() in name.lower() and group_name.lower() in name.lower():
            strict.append(p)

    if len(strict) == 1:
        return strict[0]
    if len(strict) > 1:
        strict.sort()
        return strict[0]

    loose = []
    for p in candidates:
        name = os.path.basename(p)
        if date_prefix in name and group_name.lower() in name.lower():
            loose.append(p)

    if len(loose) == 1:
        return loose[0]
    if len(loose) > 1:
        raise RuntimeError(
            f"Multiple CSV candidates for {group_name} {row_date.isoformat()} {session_type}: "
            + ", ".join(os.path.basename(x) for x in loose)
        )

    raise RuntimeError(
        f"No matching CSV for group={group_name}, date={row_date.isoformat()}, type={session_type}"
    )


# =========================
# UPLOAD HELPERS
# =========================
def open_upload_section(page):
    upload_btn = page.locator(
        "button:has-text('Upload attendance by CSV'), input[value*='Upload attendance by CSV']"
    ).first
    upload_btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    upload_btn.scroll_into_view_if_needed()
    upload_btn.click()
    page.wait_for_timeout(700)
    dismiss_popups(page)


def choose_file_in_modal(page, csv_path: str):
    choose_btn = page.locator(
        "input.fp-btn-choose[value*='Choose a file'], input[name='attendancefilechoose']"
    ).first
    choose_btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    choose_btn.click()

    file_input = page.locator("input[type='file'][name='repo_upload_file']").first
    file_input.wait_for(state="attached", timeout=DEFAULT_TIMEOUT_MS)
    file_input.set_input_files(csv_path)

    upload_this_file_btn = page.locator(
        "button:has-text('Upload this file'), .fp-upload-btn"
    ).first
    upload_this_file_btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    upload_this_file_btn.click()

    page.wait_for_timeout(1200)
    dismiss_popups(page)


def submit_first_upload(page):
    btn = page.locator("#id_submitbutton, input[name='submitbutton'][value='Upload attendance by CSV']").first
    btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    btn.scroll_into_view_if_needed()
    btn.click()
    wait_dom_ready(page)
    dismiss_popups(page)


def set_moodle_user_field_email(page):
    select = page.locator("select#id_userto, select[name='userto']").first
    select.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    try:
        select.select_option(value="email")
    except Exception:
        select.select_option(label="Email address")
    page.wait_for_timeout(400)


def submit_mapping_upload(page):
    btn = page.locator("#id_submitbutton, input[name='submitbutton'][value='Upload attendance by CSV']").first
    btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    btn.scroll_into_view_if_needed()
    btn.click()
    wait_dom_ready(page)
    dismiss_popups(page)


def click_continue(page):
    continue_btn = page.locator(
        "button:has-text('Continue'), input[value='Continue']"
    ).first
    continue_btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    continue_btn.scroll_into_view_if_needed()
    continue_btn.click()
    wait_dom_ready(page)
    dismiss_popups(page)


def upload_attendance_csv_for_current_session(page, csv_path: str):
    print(f"📎 CSV: {csv_path}")

    open_upload_section(page)
    choose_file_in_modal(page, csv_path)

    if DRY_RUN:
        print("🧪 DRY_RUN=true, stopping before submit.")
        return

    print("⬆️ Submitting uploaded file...")
    submit_first_upload(page)

    print("✏️ Setting Moodle user field = Email address")
    set_moodle_user_field_email(page)

    print("⬆️ Confirming attendance import...")
    submit_mapping_upload(page)

    print("➡️ Clicking Continue...")
    click_continue(page)


# =========================
# REPORT
# =========================
def write_report():
    if not SESSION_LOG:
        print("📋 No sessions to report.")
        return
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    # بيحط الريبورت في أول exports base dir (Technical)
    report_dir = PROFILES[0]["EXPORTS_BASE_DIR"]
    report_path = os.path.join(report_dir, f"report_{ts}.csv")
    fieldnames = ["profile", "group", "date", "session_type", "status", "csv_file", "reason"]
    with open(report_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(SESSION_LOG)
    print(f"\n📊 Report saved: {report_path}  ({len(SESSION_LOG)} rows)")


# =========================
# DATE HELPERS
# =========================
def find_start_index_by_date(rows, n: int, start_from: date) -> int:
    dates = []
    for i in range(n):
        txt = normalize_spaces(rows.nth(i).inner_text())
        dates.append(extract_date_from_row_text(txt))

    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi) // 2
        d = dates[mid]
        if d is None or d < start_from:
            lo = mid + 1
        else:
            hi = mid

    while lo < n and (dates[lo] is None or dates[lo] < start_from):
        lo += 1

    return lo


# =========================
# PROCESS ONE GROUP
# =========================
def process_group_attendance(page, group_name: str, num_group: int):
    EXPORTS_BASE_DIR = _p("EXPORTS_BASE_DIR")
    profile_name = _p("name")
    target_url = build_target_url(num_group)

    print("\n" + "=" * 100)
    print(f"🧩 GROUP: {group_name} | Num group: {num_group}")
    print(f"🔗 URL: {target_url}")
    print("=" * 100)

    group_dir = os.path.join(EXPORTS_BASE_DIR, group_name)
    if not os.path.isdir(group_dir):
        print(f"⏭️  No CSV folder found ({group_dir}). Skipping group.")
        SESSION_LOG.append({
            "profile": profile_name, "group": group_name, "date": "N/A", "session_type": "N/A",
            "status": "skipped_no_folder", "csv_file": "",
            "reason": f"Folder not found: {group_dir}",
        })
        return

    csv_files_in_folder = glob.glob(os.path.join(group_dir, "*.csv"))
    if not csv_files_in_folder:
        print(f"⏭️  CSV folder exists but has no CSV files. Skipping group.")
        SESSION_LOG.append({
            "profile": profile_name, "group": group_name, "date": "N/A", "session_type": "N/A",
            "status": "skipped_no_csv_files", "csv_file": "",
            "reason": f"No CSV files in: {group_dir}",
        })
        return

    csv_start, csv_end = get_csv_date_range_for_group(group_name)

    if GLOBAL_START_FROM_DATE:
        start_from = GLOBAL_START_FROM_DATE
        print(f"📅 START_FROM_DATE (manual): {start_from.isoformat()}")
    else:
        start_from = csv_start
        if start_from:
            print(f"📅 START_FROM_DATE (auto from CSVs): {start_from.isoformat()}")
        else:
            print("⚠️  Could not determine start date from CSVs — will process all rows.")

    end_at = csv_end
    if end_at:
        print(f"📅 END_AT_DATE (auto from CSVs): {end_at.isoformat()}")

    goto_table(page, target_url)
    rows, n = get_session_rows(page)
    print(f"📌 Visible rows: {n}")

    if n == 0:
        print("⚠️  No session rows on page. Nothing to do.")
        return

    if start_from:
        start_index = find_start_index_by_date(rows, n, start_from)
        if start_index >= n:
            print(f"⚠️  No rows found on or after {start_from.isoformat()}. Nothing to do.")
            return
        print(f"🚀 Starting from row {start_index + 1} (date >= {start_from.isoformat()})")
    else:
        start_index = 0

    uploaded = 0
    skipped_done = 0
    skipped_unknown = 0
    failed = 0

    for i in range(start_index, n):
        row_date = None
        session_type = "unknown"
        csv_file = ""
        try:
            goto_table(page, target_url)
            rows, current_n = get_session_rows(page)
            if i >= current_n:
                break

            row = rows.nth(i)
            row_text = normalize_spaces(row.inner_text())
            if not row_text:
                continue

            print("\n" + "-" * 80)
            print(f"🎯 Row {i + 1}: {row_text[:220]}")
            debug_row_actions(row, i + 1)

            row_date = extract_date_from_row_text(row_text)
            row_session_type = extract_session_type_from_title(
                extract_session_title_from_row_text(row_text))

            if end_at and row_date and row_date > end_at:
                print(f"⏹️  Row date {row_date.isoformat()} > last CSV date {end_at.isoformat()}. Done with this group.")
                break

            if row_has_change_attendance(row):
                print("⏭️ Attendance already taken. Skip.")
                skipped_done += 1
                SESSION_LOG.append({
                    "profile": profile_name, "group": group_name,
                    "date": row_date.isoformat() if row_date else "unknown",
                    "session_type": row_session_type,
                    "status": "skipped_already_taken", "csv_file": "", "reason": "",
                })
                continue

            if not row_has_take_attendance(row):
                print("⏭️ No Take attendance action found. Skip.")
                skipped_unknown += 1
                SESSION_LOG.append({
                    "profile": profile_name, "group": group_name,
                    "date": row_date.isoformat() if row_date else "unknown",
                    "session_type": row_session_type,
                    "status": "skipped_no_action", "csv_file": "", "reason": "",
                })
                continue

            if not row_date:
                raise RuntimeError("Could not parse row date")

            row_group = extract_group_from_row_text(row_text) or group_name
            session_title = extract_session_title_from_row_text(row_text)
            session_type = extract_session_type_from_title(session_title)

            print(f"📅 Date: {row_date.isoformat()}")
            print(f"👥 Group: {row_group}")
            print(f"📝 Session type: {session_type}")

            try:
                csv_path = find_csv_for_session(row_group, row_date, session_type)
                csv_file = os.path.basename(csv_path)
            except RuntimeError as csv_err:
                print(f"⚠️  CSV not found: {csv_err}")
                skipped_unknown += 1
                SESSION_LOG.append({
                    "profile": profile_name, "group": group_name,
                    "date": row_date.isoformat(), "session_type": session_type,
                    "status": "skipped_no_csv", "csv_file": "", "reason": str(csv_err),
                })
                continue

            print(f"📄 Matched CSV: {csv_file}")
            print("▶️ Opening Take attendance...")
            click_take_attendance_in_row(row)
            wait_dom_ready(page)
            dismiss_popups(page)

            upload_attendance_csv_for_current_session(page, csv_path)

            if not DRY_RUN:
                uploaded += 1
                print("✅ Attendance uploaded successfully.")
                SESSION_LOG.append({
                    "profile": profile_name, "group": group_name,
                    "date": row_date.isoformat(), "session_type": session_type,
                    "status": "uploaded", "csv_file": csv_file, "reason": "",
                })
            else:
                print("🧪 DRY_RUN completed for this session.")
                SESSION_LOG.append({
                    "profile": profile_name, "group": group_name,
                    "date": row_date.isoformat(), "session_type": session_type,
                    "status": "dry_run", "csv_file": csv_file, "reason": "",
                })

            page.wait_for_timeout(INTER_SESSION_PAUSE_MS)

        except Exception as e:
            failed += 1
            print(f"❌ Failed row {i + 1} in group {group_name}: {e}")
            SESSION_LOG.append({
                "profile": profile_name, "group": group_name,
                "date": row_date.isoformat() if row_date else "unknown",
                "session_type": session_type,
                "status": "failed", "csv_file": csv_file, "reason": str(e),
            })

    print("\n" + "#" * 90)
    print(
        f"✅ DONE GROUP: {group_name} | uploaded={uploaded} | "
        f"skipped_done={skipped_done} | skipped_unknown={skipped_unknown} | failed={failed}"
    )
    print("#" * 90)


# =========================
# RUN ONE PROFILE
# =========================
def run_profile(page, profile: dict):
    global _PROFILE
    _PROFILE = profile

    print("\n" + "█" * 110)
    print(f"🚀 STARTING PROFILE: {profile['name']}  |  COURSE_MODULE_ID={profile['COURSE_MODULE_ID']}")
    print("█" * 110)

    EXPORTS_BASE_DIR = profile["EXPORTS_BASE_DIR"]
    GROUP_TO_NUM = profile["GROUP_TO_NUM"]

    if not os.path.isdir(EXPORTS_BASE_DIR):
        print(f"❌ Exports folder not found: {EXPORTS_BASE_DIR}")
        return

    groups = GROUP_TO_NUM.copy()
    if ONLY_GROUPS:
        groups = {k: v for k, v in GROUP_TO_NUM.items() if k in ONLY_GROUPS}

    if not groups:
        print("❌ No groups selected.")
        return

    print(f"📂 Total groups to process: {len(groups)}")
    print(f"📁 Exports base: {EXPORTS_BASE_DIR}")

    for group_name, num_group in groups.items():
        try:
            process_group_attendance(page, group_name, num_group)
        except Exception as e:
            print(f"❌ Fatal error while processing {group_name}: {e}")

    print("\n" + "█" * 110)
    print(f"✅ DONE PROFILE: {profile['name']}")
    print("█" * 110)


# =========================
# MAIN
# =========================
def main():
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=False,
            channel="chrome",
            args=[
                "--disable-features=PasswordLeakDetection,SafeBrowsingEnhancedProtection",
                "--disable-save-password-bubble",
                "--disable-password-generation",
                "--password-store=basic",
            ],
        )
        page = context.new_page()
        page.set_default_timeout(DEFAULT_TIMEOUT_MS)

        ensure_logged_in(page)

        for profile in PROFILES:
            run_profile(page, profile)

        context.close()

    write_report()


if __name__ == "__main__":
    main()