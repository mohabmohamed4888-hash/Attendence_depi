import os
import re
import glob
import csv
import sys
import json
from datetime import date, datetime
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

DRY_RUN = os.getenv("DRY_RUN", "false").strip().lower() == "true"
# Ticked in the app when attendance was taken wrong on the LMS and has to be
# replaced: sessions that already have attendance are uploaded again through
# "Change attendance" instead of being skipped.
FORCE_REUPLOAD = os.getenv("FORCE_REUPLOAD", "false").strip().lower() == "true"

_start_from_raw = os.getenv("START_FROM_DATE", "").strip()
GLOBAL_START_FROM_DATE: date | None = (
    date.fromisoformat(_start_from_raw) if _start_from_raw else None
)

# Global report log
SESSION_LOG: list[dict] = []
MISSING_FROM_WAVZ_ROWS: list[dict] = []
MISSING_FROM_WAVZ_KEYS: set[tuple[str, str, str, str]] = set()
ONLY_GROUPS = parse_only_groups(os.getenv("ONLY_GROUPS", ""))
LMS_ROUND = os.getenv("LMS_ROUND", "").strip()
MISSING_FROM_WAVZ_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "exports", "missing from wavz.csv")
)
EXPORTS_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "exports"))
# Dashboard status of every student, refreshed by run_attendance.js at no cost
# from the attendance records (see student_status.js). A student the LMS
# refuses is only worth reporting while they are still active on the dashboard:
# for someone who left the program, not being in the Wavz course is expected.
STUDENT_STATUS_PATH = os.path.join(EXPORTS_ROOT, "student_status.json")
STUDENT_STATUS: dict[str, str] = {}
# Written by run_attendance.js whenever it rewrites a CSV with different content.
# Sessions listed here are uploaded again even when the LMS already has attendance.
PENDING_REUPLOADS_PATH = os.path.join(EXPORTS_ROOT, "pending_reuploads.json")
PENDING_REUPLOADS: dict[str, dict] = {}

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
            **ROUND_5_GROUPS,
        },
    },
    {
        "name": "Non-Technical",
        "track": lms_session.TRACK_NON_TECHNICAL,
        "COURSE_MODULE_ID": 6053,
        "ROUND_5_COURSE_MODULE_ID": ROUND_5_NON_TECHNICAL_COURSE_MODULE_ID,
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
            **ROUND_5_NON_TECHNICAL_GROUPS,
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
    lms_session.dismiss_chrome_password_popup(page)


def normalize_spaces(s: str) -> str:
    return " ".join((s or "").split()).strip()


def normalize_token(s: str) -> str:
    s = normalize_spaces(s).lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s


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
    # The next step needs the "Choose a file" control: wait for it instead of a fixed pause.
    try:
        page.locator(
            "input.fp-btn-choose[value*='Choose a file'], input[name='attendancefilechoose']"
        ).first.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    except Exception:
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

    # The file picker closes once the file is stored in the form's draft area.
    try:
        upload_this_file_btn.wait_for(state="hidden", timeout=DEFAULT_TIMEOUT_MS)
    except Exception:
        page.wait_for_timeout(1200)
    page.wait_for_timeout(300)
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
    page.wait_for_timeout(500)


def click_continue(page):
    continue_btn = page.locator(
        "button:has-text('Continue'), input[value='Continue']"
    ).first
    continue_btn.wait_for(state="visible", timeout=DEFAULT_TIMEOUT_MS)
    continue_btn.scroll_into_view_if_needed()
    continue_btn.click()
    wait_dom_ready(page)
    dismiss_popups(page)


def read_attendance_statuses(csv_path: str) -> dict[str, str]:
    statuses: dict[str, str] = {}
    with open(csv_path, "r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            return statuses

        columns = {
            str(name or "").strip().lower(): name
            for name in reader.fieldnames
        }
        email_column = columns.get("user_identifier") or columns.get("email")
        status_column = columns.get("status")
        if not email_column or not status_column:
            raise RuntimeError(
                f"CSV must contain user_identifier/email and status columns: {csv_path}"
            )

        for row in reader:
            email = str(row.get(email_column, "") or "").strip().lower()
            status = str(row.get(status_column, "") or "").strip().upper()
            if email:
                statuses[email] = status

    return statuses


# =========================
# DASHBOARD STATUS
# =========================
def normalize_status(status: str) -> str:
    """"Not Active", "not_active" and "not-active" are the same thing."""
    return re.sub(r"[^a-z0-9]+", "_", str(status or "").strip().lower()).strip("_")


def load_student_status():
    """Reads exports/student_status.json (written by run_attendance.js)."""
    STUDENT_STATUS.clear()
    if not os.path.isfile(STUDENT_STATUS_PATH):
        print(
            f"ℹ️ {os.path.basename(STUDENT_STATUS_PATH)} not found: every student the LMS refuses "
            "will be listed. Run the attendance export once to create it."
        )
        return

    try:
        with open(STUDENT_STATUS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        students = data.get("students") if isinstance(data, dict) else None
        if not isinstance(students, dict):
            return
        for email, info in students.items():
            status = normalize_status(
                info.get("status") if isinstance(info, dict) else info
            )
            if status:
                STUDENT_STATUS[str(email).strip().lower()] = status
    except Exception as e:
        print(f"⚠️ Could not read {os.path.basename(STUDENT_STATUS_PATH)}: {e}")
        return

    not_active = sum(1 for s in STUDENT_STATUS.values() if s != "active")
    print(
        f"🧾 Dashboard status loaded for {len(STUDENT_STATUS)} students "
        f"({not_active} not active); not-active students are left out of the missing-from-Wavz list."
    )


def is_not_active_on_dashboard(email: str) -> bool:
    """True only when the status is known AND is not "active".

    An unknown status never hides a student: it would hide a real enrolment
    problem behind a missing lookup.
    """
    status = STUDENT_STATUS.get(str(email or "").strip().lower(), "")
    return bool(status) and status != "active"


def load_existing_missing_from_wavz():
    if not os.path.isfile(MISSING_FROM_WAVZ_PATH):
        return

    dropped = []
    try:
        with open(MISSING_FROM_WAVZ_PATH, "r", newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                normalized = {
                    "group": str(row.get("group", "") or "").strip(),
                    "email": str(row.get("email", "") or "").strip().lower(),
                    "status": str(row.get("status", "") or "").strip().upper(),
                    "csv_file": str(row.get("csv_file", "") or "").strip(),
                }
                if not normalized["email"]:
                    continue
                # Students who left the program are dropped from the old list too.
                if is_not_active_on_dashboard(normalized["email"]):
                    dropped.append(normalized["email"])
                    continue
                key = (
                    normalized["group"],
                    normalized["email"],
                    normalized["status"],
                    normalized["csv_file"],
                )
                if key not in MISSING_FROM_WAVZ_KEYS:
                    MISSING_FROM_WAVZ_KEYS.add(key)
                    MISSING_FROM_WAVZ_ROWS.append(normalized)
    except Exception as e:
        print(f"⚠️ Could not read existing missing-from-Wavz report: {e}")
        return

    if dropped:
        print(
            f"🧹 Dropped {len(dropped)} row(s) from the old missing-from-Wavz list: "
            f"not active on the dashboard ({', '.join(sorted(set(dropped))[:5])}"
            f"{', ...' if len(set(dropped)) > 5 else ''})"
        )
        try:
            write_missing_from_wavz()
        except Exception as e:
            print(f"⚠️ Could not rewrite the missing-from-Wavz report: {e}")


def write_missing_from_wavz():
    os.makedirs(os.path.dirname(MISSING_FROM_WAVZ_PATH), exist_ok=True)
    fieldnames = ["group", "email", "status", "csv_file"]
    with open(MISSING_FROM_WAVZ_PATH, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(
            sorted(
                MISSING_FROM_WAVZ_ROWS,
                key=lambda row: (
                    row["group"],
                    row["email"],
                    row["csv_file"],
                    row["status"],
                ),
            )
        )


# =========================
# PENDING RE-UPLOADS
# run_attendance.js lists every CSV it rewrote with different content in
# exports/pending_reuploads.json. Those sessions are uploaded again even when
# the LMS already has attendance for them, then removed from the list.
# =========================
def pending_reupload_key(csv_path: str) -> str:
    return os.path.relpath(os.path.abspath(csv_path), EXPORTS_ROOT).replace("\\", "/")


def load_pending_reuploads():
    PENDING_REUPLOADS.clear()
    if not os.path.isfile(PENDING_REUPLOADS_PATH):
        return
    try:
        with open(PENDING_REUPLOADS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for key, info in data.items():
                PENDING_REUPLOADS[str(key)] = info if isinstance(info, dict) else {}
    except Exception as e:
        print(f"⚠️ Could not read {os.path.basename(PENDING_REUPLOADS_PATH)}: {e}")
        return
    if PENDING_REUPLOADS:
        print(f"♻️ {len(PENDING_REUPLOADS)} updated CSV(s) are waiting to be re-uploaded:")
        for key, info in sorted(PENDING_REUPLOADS.items()):
            print(f"   - {key} (changed {info.get('updatedAt', 'unknown time')})")


def save_pending_reuploads():
    try:
        if PENDING_REUPLOADS:
            with open(PENDING_REUPLOADS_PATH, "w", encoding="utf-8") as f:
                json.dump(PENDING_REUPLOADS, f, ensure_ascii=False, indent=2)
        elif os.path.isfile(PENDING_REUPLOADS_PATH):
            os.remove(PENDING_REUPLOADS_PATH)
    except Exception as e:
        print(f"⚠️ Could not save {os.path.basename(PENDING_REUPLOADS_PATH)}: {e}")


def collect_missing_from_wavz(page, group_name: str, csv_path: str) -> int:
    alert_texts = page.locator(".alert, [role='alert']").all_inner_texts()
    missing_emails: set[str] = set()
    pattern = re.compile(
        r"A user with the email set to\s+([^\s]+?)\s+could not be found in this course",
        flags=re.I,
    )

    for text in alert_texts:
        for match in pattern.finditer(text or ""):
            missing_emails.add(match.group(1).strip().lower())

    if not missing_emails:
        return 0

    # A student who is not active on the dashboard left the program, so the LMS
    # refusing them is expected and they are not reported.
    not_active = sorted(e for e in missing_emails if is_not_active_on_dashboard(e))
    if not_active:
        missing_emails -= set(not_active)
        print(
            f"🧹 Not reported ({len(not_active)} not active on the dashboard): "
            + ", ".join(not_active)
        )
    if not missing_emails:
        return 0

    statuses = read_attendance_statuses(csv_path)
    csv_file = os.path.basename(csv_path)
    added = 0

    for email in sorted(missing_emails):
        status = statuses.get(email, "")
        if status not in {"P", "A"}:
            print(f"⚠️ Missing Wavz email found but CSV status is unreadable: {email}")

        row = {
            "group": group_name,
            "email": email,
            "status": status,
            "csv_file": csv_file,
        }
        key = (group_name, email, status, csv_file)
        if key in MISSING_FROM_WAVZ_KEYS:
            continue

        MISSING_FROM_WAVZ_KEYS.add(key)
        MISSING_FROM_WAVZ_ROWS.append(row)
        added += 1

    try:
        write_missing_from_wavz()
    except Exception as e:
        # Attendance may already be uploaded at this point, so a locked report
        # file must not incorrectly mark the LMS upload itself as failed.
        print(f"⚠️ Could not save missing-from-Wavz report yet: {e}")
    print(
        f"👤 Missing from Wavz: found={len(missing_emails)}, new={added}, "
        f"file={MISSING_FROM_WAVZ_PATH}"
    )
    return len(missing_emails)


def upload_attendance_csv_for_current_session(page, csv_path: str, group_name: str):
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

    collect_missing_from_wavz(page, group_name, csv_path)

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
    # بيحط الريبورت في أول exports base dir بتاع الـ track المختار
    report_dir = (SELECTED_PROFILES or PROFILES)[0]["EXPORTS_BASE_DIR"]
    os.makedirs(report_dir, exist_ok=True)
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
def find_start_index_by_dates(dates: list, start_from: date) -> int:
    """First index whose date is on/after start_from (rows are in date order)."""
    n = len(dates)
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
    target_url = build_target_url(num_group, group_name)

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

    group_started = datetime.now()

    # One page load and one read of the whole table per group. Every decision
    # below is taken on this snapshot, and each upload opens the row's own
    # take.php link directly, so the table is not reloaded between rows.
    goto_table(page, target_url)
    snapshot = lms_session.parse_sessions_table(page)
    n = len(snapshot)
    print(f"📌 Visible rows: {n}")

    if n == 0:
        print("⚠️  No session rows on page. Nothing to do.")
        return

    dates = [extract_date_from_row_text(row["text"]) for row in snapshot]

    if start_from:
        start_index = find_start_index_by_dates(dates, start_from)
        if start_index >= n:
            print(f"⚠️  No rows found on or after {start_from.isoformat()}. Nothing to do.")
            return
        print(f"🚀 Starting from row {start_index + 1} (date >= {start_from.isoformat()})")
    else:
        start_index = 0

    uploaded = 0
    reuploaded = 0
    skipped_done = 0
    skipped_unknown = 0
    failed = 0
    to_verify = []

    for i in range(start_index, n):
        row_date = None
        session_type = "unknown"
        csv_file = ""
        try:
            row = snapshot[i]
            row_text = row["text"]
            if not row_text:
                continue

            print("\n" + "-" * 80)
            print(f"🎯 Row {i + 1}: {row_text[:220]}")

            row_date = dates[i]
            row_session_type = extract_session_type_from_title(
                extract_session_title_from_row_text(row_text))

            if end_at and row_date and row_date > end_at:
                print(f"⏹️  Row date {row_date.isoformat()} > last CSV date {end_at.isoformat()}. Done with this group.")
                break

            already_taken = row["attendance_taken"]
            if not already_taken and not row["take_href"]:
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
                if already_taken:
                    print("⏭️ Attendance already taken. Skip.")
                    skipped_done += 1
                    SESSION_LOG.append({
                        "profile": profile_name, "group": group_name,
                        "date": "unknown", "session_type": row_session_type,
                        "status": "skipped_already_taken", "csv_file": "", "reason": "",
                    })
                    continue
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
                if already_taken:
                    print("⏭️ Attendance already taken and there is no CSV to re-upload. Skip.")
                    skipped_done += 1
                    SESSION_LOG.append({
                        "profile": profile_name, "group": group_name,
                        "date": row_date.isoformat(), "session_type": session_type,
                        "status": "skipped_already_taken", "csv_file": "", "reason": "",
                    })
                    continue
                print(f"⚠️  CSV not found: {csv_err}")
                skipped_unknown += 1
                SESSION_LOG.append({
                    "profile": profile_name, "group": group_name,
                    "date": row_date.isoformat(), "session_type": session_type,
                    "status": "skipped_no_csv", "csv_file": "", "reason": str(csv_err),
                })
                continue

            reupload_key = pending_reupload_key(csv_path)
            if already_taken:
                # The LMS already has this session's attendance. It is only
                # touched again when run_attendance.js rewrote the CSV since
                # (the CSV is then listed in pending_reuploads.json), or when
                # the re-upload option was ticked to correct attendance that
                # was taken wrong.
                is_pending = reupload_key in PENDING_REUPLOADS
                if not is_pending and not FORCE_REUPLOAD:
                    print(f"⏭️ Attendance already taken and {csv_file} did not change since. Skip.")
                    skipped_done += 1
                    SESSION_LOG.append({
                        "profile": profile_name, "group": group_name,
                        "date": row_date.isoformat(), "session_type": session_type,
                        "status": "skipped_already_taken", "csv_file": csv_file, "reason": "",
                    })
                    continue

                if is_pending:
                    changed_at = PENDING_REUPLOADS[reupload_key].get("updatedAt", "unknown time")
                    print(f"📄 Matched CSV: {csv_file} (changed {changed_at})")
                    print("♻️ Attendance already taken, but the CSV changed since. Opening Change attendance...")
                else:
                    print(f"📄 Matched CSV: {csv_file}")
                    print("♻️ Attendance already taken; re-upload option is on, so it is uploaded again. "
                          "Opening Change attendance...")
                target_href = row["change_href"]
            else:
                print(f"📄 Matched CSV: {csv_file}")
                print("▶️ Opening Take attendance...")
                target_href = row["take_href"]

            # Same page the row icon opens (take.php?...&sessionid=...).
            page.goto(target_href)
            wait_dom_ready(page)
            dismiss_popups(page)

            upload_attendance_csv_for_current_session(page, csv_path, row_group)

            if not DRY_RUN:
                if already_taken:
                    reuploaded += 1
                    print("✅ Attendance re-uploaded successfully.")
                else:
                    uploaded += 1
                    print("✅ Attendance uploaded successfully.")
                pending_info = PENDING_REUPLOADS.pop(reupload_key, None)
                if pending_info is not None:
                    save_pending_reuploads()
                SESSION_LOG.append({
                    "profile": profile_name, "group": group_name,
                    "date": row_date.isoformat(), "session_type": session_type,
                    "status": "reuploaded" if already_taken else "uploaded",
                    "csv_file": csv_file, "reason": "",
                })
                to_verify.append({
                    "session_id": row["session_id"],
                    "label": f"{row_date.isoformat()} | {session_type}",
                    "csv_file": csv_file,
                    "log_index": len(SESSION_LOG) - 1,
                    "pending": (reupload_key, pending_info),
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

    verified, verify_failed = verify_uploads(page, target_url, to_verify)

    print("\n" + "#" * 90)
    print(
        f"✅ DONE GROUP: {group_name} | uploaded={uploaded} | reuploaded={reuploaded} | "
        f"verified={verified} | verify_failed={verify_failed} | "
        f"skipped_done={skipped_done} | skipped_unknown={skipped_unknown} | failed={failed} "
        f"| {(datetime.now() - group_started).total_seconds():.1f}s"
    )
    print("#" * 90)


def verify_uploads(page, target_url: str, to_verify: list) -> "tuple[int, int]":
    """Reloads the group's table once and checks that every session uploaded in
    this run now shows attendance as taken. A miss is reported as verify_failed
    and, for a CSV that was pending re-upload, the CSV goes back on the list."""
    if not to_verify:
        return 0, 0

    print(f"\n🔍 Verifying {len(to_verify)} uploaded session(s) on the sessions table...")
    try:
        goto_table(page, target_url)
        after = {
            row["session_id"]: row
            for row in lms_session.parse_sessions_table(page)
            if row["session_id"]
        }
    except Exception as e:
        print(f"⚠️ Could not reload the table to verify the uploads: {e}")
        return 0, 0

    verified = 0
    verify_failed = 0
    for item in to_verify:
        row = after.get(item["session_id"])
        if row and row["attendance_taken"]:
            verified += 1
            continue

        verify_failed += 1
        print(
            f"❌ Verification failed: {item['label']} ({item['csv_file']}) does not show "
            "attendance as taken. Check it on the LMS."
        )
        entry = SESSION_LOG[item["log_index"]]
        entry["status"] = "verify_failed"
        entry["reason"] = "attendance not shown as taken after the upload"
        key, info = item["pending"]
        if info is not None:
            PENDING_REUPLOADS[key] = info
            save_pending_reuploads()

    if not verify_failed:
        print(f"✅ Verified: all {verified} uploaded session(s) show attendance as taken.")
    return verified, verify_failed


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
    if LMS_ROUND:
        groups = {
            name: number for name, number in groups.items()
            if re.match(r"^[A-Za-z]{3,4}" + re.escape(LMS_ROUND), name)
        }
    if ONLY_GROUPS:
        groups = {k: v for k, v in GROUP_TO_NUM.items() if k in ONLY_GROUPS}
        print(f"🎯 Group filter active for profile {profile['name']}: {', '.join(sorted(ONLY_GROUPS))}")

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
    if FORCE_REUPLOAD:
        print(
            "♻️ Re-upload option is ON: sessions that already have attendance on the LMS "
            "will be uploaded again and their current attendance replaced."
        )
    load_student_status()
    load_existing_missing_from_wavz()
    load_pending_reuploads()

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

                run_profile(page, profile)
        finally:
            if context is not None:
                context.close()

    if MISSING_FROM_WAVZ_ROWS:
        try:
            write_missing_from_wavz()
        except Exception as e:
            print(f"⚠️ Final missing-from-Wavz report save failed: {e}")

    write_report()

    if PENDING_REUPLOADS:
        print(
            f"\n♻️ Still waiting for re-upload ({len(PENDING_REUPLOADS)}): not reached in this run "
            "(outside the selected groups/dates), failed, or DRY_RUN. They stay listed for the next run:"
        )
        for key, info in sorted(PENDING_REUPLOADS.items()):
            print(f"   - {key} (changed {info.get('updatedAt', 'unknown time')})")


if __name__ == "__main__":
    main()
