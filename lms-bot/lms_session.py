"""Shared LMS session helpers (accounts, Chrome profile, login / logout).

Used by both upload.py and edit.py so the Technical and Non-Technical runs
behave exactly the same way:

  * every track has its own LMS account and its own Chrome profile folder
  * before a track runs we make sure the browser is signed in with that
    track's account (logging the previous one out when needed)
  * the Chrome "your password was found in a data breach" popup is prevented
    up front and dismissed (OK) if it still shows up
"""

import json
import os
import re

from dotenv import load_dotenv


def load_env() -> None:
    """Loads the nearest .env, then fills the rest from the project-root .env.

    load_dotenv() never overrides values that are already set, so running the
    bots from lms-bot/ still picks up the accounts kept in the root .env.
    """
    load_dotenv()
    load_dotenv(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, ".env")
    )

load_env()

LMS_BASE_URL = "https://lms.wavz.com.eg:8443"
LOGIN_URL = f"{LMS_BASE_URL}/login/index.php"
LOGOUT_URL = f"{LMS_BASE_URL}/login/logout.php"
HOME_URL = f"{LMS_BASE_URL}/my/"
PROFILE_EDIT_URL = f"{LMS_BASE_URL}/user/edit.php"

BASE_PROFILE_DIR = os.getenv(
    "CHROME_PROFILE_BASE_DIR", r"C:\Users\mohab\Desktop\pw-profile"
)

TRACK_TECHNICAL = "technical"
TRACK_NON_TECHNICAL = "nontechnical"
TRACK_ALL = "all"

CHROME_LAUNCH_ARGS = [
    "--disable-features=PasswordLeakDetection,PasswordLeakDetectionEnabled,"
    "SafeBrowsingEnhancedProtection,AutofillServerCommunication",
    "--disable-save-password-bubble",
    "--disable-password-generation",
    "--password-store=basic",
    "--no-default-browser-check",
    "--no-first-run",
]


# =========================
# TRACK / ACCOUNT RESOLUTION
# =========================
def normalize_track(raw_track: str) -> str:
    track = re.sub(r"[^a-z]", "", str(raw_track or "").strip().lower())
    if track in {"technical", "tech"}:
        return TRACK_TECHNICAL
    if track in {"nontechnical", "nontech"}:
        return TRACK_NON_TECHNICAL
    return TRACK_ALL


def track_label(raw_track: str) -> str:
    track = normalize_track(raw_track)
    if track == TRACK_TECHNICAL:
        return "Technical"
    if track == TRACK_NON_TECHNICAL:
        return "Non-Technical"
    return "All"


def selected_track() -> str:
    return normalize_track(os.getenv("LMS_TRACK", ""))


def track_is_selected(track: str) -> bool:
    selected = selected_track()
    return selected == TRACK_ALL or selected == normalize_track(track)


def account_for_track(track: str) -> "tuple[str, str]":
    """Returns (email, password) for a track.

    Non-Technical groups live on a different LMS account, so they read
    LMS_NONTECH_EMAIL / LMS_NONTECH_PASSWORD from .env. When those are empty
    the Technical account is reused (single-account setup).
    """
    technical = (
        os.getenv("LMS_EMAIL", "").strip(),
        os.getenv("LMS_PASSWORD", "").strip(),
    )

    if normalize_track(track) != TRACK_NON_TECHNICAL:
        return technical

    email = (
        os.getenv("LMS_NONTECH_EMAIL", "").strip()
        or os.getenv("LMS_NON_TECHNICAL_EMAIL", "").strip()
    )
    password = (
        os.getenv("LMS_NONTECH_PASSWORD", "").strip()
        or os.getenv("LMS_NON_TECHNICAL_PASSWORD", "").strip()
    )

    if not email or not password:
        print(
            "⚠️ LMS_NONTECH_EMAIL / LMS_NONTECH_PASSWORD are not set in .env — "
            "the Non-Technical groups will use the Technical account."
        )
        return technical

    return email, password


def user_data_dir_for(email: str) -> str:
    safe_email = re.sub(r"[^a-zA-Z0-9]+", "_", (email or "default").lower())
    return os.path.join(BASE_PROFILE_DIR, safe_email)


# =========================
# CHROME PROFILE HARDENING
# =========================
def harden_chrome_profile(user_data_dir: str) -> None:
    """Turns off Chrome password manager / leak detection for this profile.

    This is what stops the native "Change your password — the password you
    just used was found in a data breach" dialog from popping up after login.
    """
    prefs_path = os.path.join(user_data_dir, "Default", "Preferences")
    try:
        os.makedirs(os.path.dirname(prefs_path), exist_ok=True)

        prefs = {}
        if os.path.isfile(prefs_path):
            with open(prefs_path, "r", encoding="utf-8") as f:
                prefs = json.load(f) or {}

        prefs["credentials_enable_service"] = False
        prefs["credentials_enable_autosignin"] = False

        profile_prefs = prefs.get("profile")
        if not isinstance(profile_prefs, dict):
            profile_prefs = {}
        profile_prefs["password_manager_leak_detection"] = False
        profile_prefs["password_manager_enabled"] = False
        prefs["profile"] = profile_prefs

        with open(prefs_path, "w", encoding="utf-8") as f:
            json.dump(prefs, f)
    except Exception as e:
        print(f"⚠️ Could not pre-configure the Chrome profile ({e}). Continuing.")


def dismiss_chrome_password_popup(page) -> None:
    """Clicks OK on the Chrome 'Change your password' breach popup."""
    try:
        ok_btn = page.locator(
            "button:has-text('OK'), [role='button']:has-text('OK'), "
            "button:has-text('Ok'), input[value='OK']"
        ).first
        if ok_btn.count() > 0 and ok_btn.is_visible(timeout=2000):
            ok_btn.click()
            page.wait_for_timeout(400)
            print("🔒 Dismissed the Chrome password breach popup (OK).")
    except Exception:
        pass

    # The breach warning is a browser-level bubble, so a click inside the page
    # (plus Escape) is what actually closes it when it is not part of the DOM.
    try:
        page.bring_to_front()
        page.mouse.click(5, 5)
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    except Exception:
        pass


# =========================
# LOGIN / LOGOUT
# =========================
def _wait_dom_ready(page, short_timeout_ms: int) -> None:
    try:
        page.wait_for_load_state("domcontentloaded")
    except Exception:
        pass
    try:
        page.wait_for_load_state("networkidle", timeout=short_timeout_ms)
    except Exception:
        pass


def _login_form(page):
    email = page.locator(
        "input[name='username'], input#username, input[type='email']"
    ).first
    pwd = page.locator(
        "input[name='password'], input#password, input[type='password']"
    ).first
    login = page.locator("button[type='submit'], #loginbtn").first
    return email, pwd, login


def get_sesskey(page) -> str:
    try:
        return str(
            page.evaluate(
                "() => (window.M && M.cfg && M.cfg.sesskey) ? M.cfg.sesskey : ''"
            )
            or ""
        )
    except Exception:
        return ""


def current_account_email(page, short_timeout_ms: int = 6000) -> str:
    """Reads the email of the account the saved session belongs to."""
    try:
        page.goto(PROFILE_EDIT_URL)
        _wait_dom_ready(page, short_timeout_ms)

        if "login/index.php" in page.url.lower():
            return ""

        field = page.locator("input#id_email, input[name='email']").first
        if field.count() > 0:
            return str(field.input_value() or "").strip().lower()
    except Exception:
        pass
    return ""


def logout(page, short_timeout_ms: int = 6000) -> None:
    """Logs the current LMS account out (user menu -> Log out)."""
    try:
        page.goto(HOME_URL)
        _wait_dom_ready(page, short_timeout_ms)

        if "login/index.php" in page.url.lower():
            print("ℹ️ No active LMS session to log out from.")
            return

        sesskey = get_sesskey(page)
        if sesskey:
            page.goto(f"{LOGOUT_URL}?sesskey={sesskey}")
        else:
            menu = page.locator(
                "#user-menu-toggle, .usermenu [role='button'], a.dropdown-toggle .userbutton"
            ).first
            if menu.count() > 0:
                menu.click()
                page.wait_for_timeout(500)
            link = page.locator("a:has-text('Log out'), a[href*='login/logout.php']").first
            if link.count() > 0:
                link.click()

        _wait_dom_ready(page, short_timeout_ms)

        confirm = page.locator(
            "button:has-text('Yes'), input[value='Yes'], button:has-text('Continue')"
        ).first
        if confirm.count() > 0 and confirm.is_visible(timeout=1500):
            confirm.click()
            _wait_dom_ready(page, short_timeout_ms)

        print("🚪 Logged out of the previous LMS account.")
    except Exception as e:
        print(f"⚠️ Logout attempt failed ({e}). Continuing with a fresh login.")


def login(page, email: str, password: str, default_timeout_ms: int, short_timeout_ms: int) -> None:
    if not email or not password:
        raise RuntimeError(
            "Missing LMS credentials. Set LMS_EMAIL / LMS_PASSWORD (and "
            "LMS_NONTECH_EMAIL / LMS_NONTECH_PASSWORD for Non-Technical groups) in .env."
        )

    page.goto(LOGIN_URL)
    _wait_dom_ready(page, short_timeout_ms)

    email_input, pwd_input, login_btn = _login_form(page)
    email_input.wait_for(state="visible", timeout=default_timeout_ms)
    pwd_input.wait_for(state="visible", timeout=default_timeout_ms)
    login_btn.wait_for(timeout=default_timeout_ms)

    email_input.fill(email)
    pwd_input.fill(password)

    print(f"🔐 Logging in as {email} ...")
    login_btn.click(no_wait_after=True)
    page.wait_for_timeout(4000)
    _wait_dom_ready(page, short_timeout_ms)

    dismiss_chrome_password_popup(page)

    logged_in = False
    for _ in range(12):
        if "login/index.php" not in page.url.lower():
            logged_in = True
            break
        try:
            if not pwd_input.is_visible(timeout=500):
                logged_in = True
                break
        except Exception:
            pass
        page.wait_for_timeout(1000)

    dismiss_chrome_password_popup(page)

    if not logged_in:
        login_error = ""
        try:
            err = page.locator(".alert-danger, .loginerrors, .error, .alert").first
            if err.count() > 0 and err.is_visible(timeout=1000):
                login_error = err.inner_text().strip()
        except Exception:
            pass
        raise RuntimeError(
            f"Login failed for {email}. URL={page.url}"
            f"{' | Error: ' + login_error if login_error else ''}"
        )

    print(f"✅ Logged in as {email}. URL: {page.url}")


def ensure_account(
    page,
    email: str,
    password: str,
    default_timeout_ms: int = 25000,
    short_timeout_ms: int = 6000,
) -> None:
    """Makes sure the browser is signed in with exactly this account."""
    page.goto(LOGIN_URL)
    _wait_dom_ready(page, short_timeout_ms)

    email_input, pwd_input, _ = _login_form(page)

    login_form_visible = False
    try:
        login_form_visible = (
            email_input.count() > 0
            and pwd_input.count() > 0
            and email_input.is_visible(timeout=1500)
            and pwd_input.is_visible(timeout=1500)
        )
    except Exception:
        login_form_visible = False

    if login_form_visible:
        login(page, email, password, default_timeout_ms, short_timeout_ms)
        return

    session_email = current_account_email(page, short_timeout_ms)
    if session_email and email and session_email != email.strip().lower():
        print(
            f"🔄 Saved session belongs to {session_email}, but {email} is needed. "
            "Logging out first."
        )
        logout(page, short_timeout_ms)
        login(page, email, password, default_timeout_ms, short_timeout_ms)
        return

    print(f"✅ Using the saved Chrome session for {session_email or email}.")
