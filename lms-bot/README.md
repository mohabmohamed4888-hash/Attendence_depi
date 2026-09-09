# LMS Edit Bot (Playwright)

## What it does
- You open the LMS page, login, and apply filters manually.
- The script then:
  - finds the row by (date + group),
  - clicks the edit (pencil) icon,
  - fills the session/title text from `sessions.csv`,
  - clicks Save.

## Requirements
- Python 3.9+ recommended
- Google Chrome installed
- Close all Chrome windows before running (profile lock)

## Install
```bash
pip install playwright
playwright install
```

## Run
```bash
python run_lms_bot.py
```
Then:
1) A Chrome window opens using your existing profile
2) Open LMS list page
3) Apply filters
4) Go back to terminal and press Enter

## IMPORTANT: Tune selectors once
Because each LMS UI differs, capture exact selectors:
```bash
playwright codegen
```
Then click:
- pencil/edit button
- title field
- save button

Send those 3 lines back to ChatGPT and we'll paste them into the script.
