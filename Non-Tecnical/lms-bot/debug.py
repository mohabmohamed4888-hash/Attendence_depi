from playwright.sync_api import sync_playwright


def dump_editor_candidates(page):
    print("\n=== EDITOR CANDIDATES DUMP ===")

    # 1) iframes
    iframe_count = page.locator("iframe").count()
    print(f"[iframes] count = {iframe_count}")
    for i in range(min(iframe_count, 12)):
        el = page.locator("iframe").nth(i)
        title = el.get_attribute("title")
        name = el.get_attribute("name")
        aria = el.get_attribute("aria-label")
        src = el.get_attribute("src")
        print(f"  - iframe[{i}] title={title!r} name={name!r} aria-label={aria!r} src={src!r}")

    # 2) contenteditable=true
    ce_count = page.locator("[contenteditable='true']").count()
    print(f"[contenteditable=true] count = {ce_count}")
    for i in range(min(ce_count, 12)):
        el = page.locator("[contenteditable='true']").nth(i)
        tag = el.evaluate("e => e.tagName")
        cls = el.get_attribute("class")
        rid = el.get_attribute("id")
        aria = el.get_attribute("aria-label")
        role = el.get_attribute("role")
        print(f"  - ce[{i}] tag={tag} id={rid!r} class={cls!r} aria-label={aria!r} role={role!r}")

    # 3) textarea
    ta_count = page.locator("textarea").count()
    print(f"[textarea] count = {ta_count}")
    for i in range(min(ta_count, 12)):
        el = page.locator("textarea").nth(i)
        rid = el.get_attribute("id")
        name = el.get_attribute("name")
        aria = el.get_attribute("aria-label")
        print(f"  - textarea[{i}] id={rid!r} name={name!r} aria-label={aria!r}")

    print("=== END DUMP ===\n")


def set_description_smart(page, text: str):
    """
    Tries to fill description editor using:
      1) iframe[title="Rich text area"] (TinyMCE-like)
      2) any iframe body
      3) [contenteditable="true"]
      4) textarea
    """

    # خليك متأكد الصفحة هادية شوية
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    page.wait_for_timeout(800)

    # 1) TinyMCE style iframe title
    iframe = page.locator("iframe[title='Rich text area']")
    if iframe.count() > 0:
        frame = page.frame_locator("iframe[title='Rich text area']")
        body = frame.locator("body")
        body.wait_for(state="visible", timeout=15000)
        body.click()
        body.press("Control+A")
        body.type(text, delay=5)
        print("✅ Description set via iframe[title='Rich text area']")
        return True

    # 2) Any iframe body (fallback)
    iframe_count = page.locator("iframe").count()
    if iframe_count > 0:
        for i in range(min(iframe_count, 6)):
            try:
                fr = page.frame_locator("iframe").nth(i)
                body = fr.locator("body")
                body.wait_for(state="visible", timeout=3000)
                body.click()
                body.press("Control+A")
                body.type(text, delay=5)
                print(f"✅ Description set via iframe nth({i})")
                return True
            except Exception:
                continue

    # 3) Contenteditable (CKEditor/Quill)
    ce = page.locator("[contenteditable='true']")
    if ce.count() > 0:
        target = ce.first
        target.wait_for(state="visible", timeout=15000)
        target.scroll_into_view_if_needed()
        target.click()
        target.press("Control+A")
        target.type(text, delay=5)
        print("✅ Description set via [contenteditable='true']")
        return True

    # 4) textarea fallback
    ta = page.locator("textarea")
    if ta.count() > 0:
        target = ta.first
        target.wait_for(state="visible", timeout=15000)
        target.scroll_into_view_if_needed()
        target.fill(text)
        print("✅ Description set via textarea")
        return True

    print("❌ Could not find any editor (iframe/contenteditable/textarea)")
    return False


def main():
    TEST_TEXT = "TEST DESC - Playwright locator debug ✅"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, slow_mo=150)
        context = browser.new_context()
        page = context.new_page()

        # افتح صفحة عامة كبداية (مش مهم). انت هتتنقل بنفسك من هنا لصفحة تعديل السيشن.
        page.goto("https://www.google.com", wait_until="domcontentloaded")

        print("\n>>> المتصفح فتح.")
        print(">>> دلوقتي روح بنفسك للـ LMS وسجل دخولك وافتح صفحة تعديل السيشن اللي فيها الـ Description.")
        print(">>> لما تبقى واقف على صفحة تعديل السيشن والـ Description ظاهر قدامك، ارجع للـ Inspector واضغط Resume.\n")

        # يوقف هنا ويطلع Inspector
        page.pause()

        # بعد ما تعمل Resume:
        dump_editor_candidates(page)

        ok = set_description_smart(page, TEST_TEXT)
        if ok:
            print("\n✅ تم تجربة الكتابة. لو النص اتكتب صح، يبقى عرفنا الطريق.")
            print("➡️ ابعتلي ناتج الـ dump (iframes count + contenteditable count) وأنا أطلعلك selector نهائي مضبوط.")
        else:
            print("\n❌ لسه مش لاقي المحرر. ابعتلي ناتج الـ dump كله ولقطة من الـ DOM لو تقدر.")

        # سيب المتصفح مفتوح شوية
        page.wait_for_timeout(5000)
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
