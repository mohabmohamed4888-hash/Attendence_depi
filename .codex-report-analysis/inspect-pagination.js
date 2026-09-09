require('dotenv').config({ path: '../.env' });
const { chromium } = require('../node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://dashboard.depi.eyouthbusiness.com/auth/login');
  await page.fill('input[type="email"]', process.env.LOGIN_EMAIL);
  await page.fill('#password', process.env.LOGIN_PASSWORD);
  await page.click('button:has-text("Login")');
  await page.waitForLoadState('networkidle');
  await page.goto('https://dashboard.depi.eyouthbusiness.com/super_admin/sessions');
  await page.waitForLoadState('networkidle');
  const info = await page.evaluate(() => [...document.querySelectorAll('a,button')]
    .map((element) => ({
      text: (element.textContent || '').trim(),
      aria: element.getAttribute('aria-label'),
      href: element.getAttribute('href'),
      rel: element.getAttribute('rel'),
      disabled: element.disabled || element.getAttribute('aria-disabled'),
    }))
    .filter((item) =>
      item.href?.includes('page=') || item.rel || /next|previous|pagination/i.test(`${item.text} ${item.aria}`)
    ));
  console.log(JSON.stringify({ url: page.url(), info }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
