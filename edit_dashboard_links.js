require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://dashboard.depi.eyouthbusiness.com/auth/login';
const SESSIONS_URL = 'https://dashboard.depi.eyouthbusiness.com/super_admin/sessions';
const EXPORT_DIR = path.join(__dirname, 'exports');
const DRY_RUN = process.argv.includes('--dry-run');

const L = {
  filterBtn: 'button[data-slot="dialog-trigger"]',
  filterDialog: '[role="dialog"]',
  groupFilterBtn: 'button[data-slot="popover-trigger"]',
  dateFrom: '#date_from',
  dateTo: '#date_to',
  rows: 'table tbody tr',
};

function readConfig() {
  const configIndex = process.argv.indexOf('--config');
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : '';
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error('A valid --config file is required.');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    dateFrom: String(config.dateFrom || '').trim(),
    dateTo: String(config.dateTo || '').trim(),
    groupFilter: String(config.groupFilter || '').trim(),
    roundFilter: String(config.roundFilter || '').trim(),
    newLink: String(config.newLink || '').trim(),
  };
}

function validateConfig(config) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(config.dateTo)) {
    throw new Error('Date From and Date To must use YYYY-MM-DD.');
  }
  if (config.dateFrom > config.dateTo) throw new Error('Date From cannot be after Date To.');
  if (!config.groupFilter) throw new Error('Choose one group before editing dashboard links.');
  if (!['4', '5'].includes(config.roundFilter)) throw new Error('Choose Round 4 or Round 5.');
  const groupRound = config.groupFilter.match(/^[A-Za-z]{3,4}([45])/)?.[1] || '';
  if (groupRound && groupRound !== config.roundFilter) {
    throw new Error(`${config.groupFilter} belongs to Round ${groupRound}, not Round ${config.roundFilter}.`);
  }
  let parsed;
  try {
    parsed = new URL(config.newLink);
  } catch {
    throw new Error('New Session Link must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('New Session Link must start with http:// or https://.');
  }
}

function dashboardRound(roundFilter) {
  return roundFilter === '4' ? 'First' : 'Second';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openFilterDialog(page) {
  let filterBtn = page.locator(L.filterBtn).filter({ hasText: /^Filter$/i }).last();
  if (!(await filterBtn.count().catch(() => 0))) {
    filterBtn = page.getByRole('button', { name: /^Filter$/i }).last();
  }
  await filterBtn.waitFor({ state: 'visible', timeout: 20000 });
  await filterBtn.click();

  const applyBtn = page.getByRole('button', {
    name: /^Apply Filter(?:\s*\(\d+\))?$/i,
  }).first();
  await applyBtn.waitFor({ state: 'visible', timeout: 20000 });

  const roleDialog = page.locator(L.filterDialog).filter({ has: applyBtn }).first();
  if (await roleDialog.count().catch(() => 0) && await roleDialog.isVisible().catch(() => false)) {
    return roleDialog;
  }

  const panel = applyBtn.locator(
    `xpath=ancestor::*[self::div or self::section][.//*[normalize-space(.)='Filter by'] and .//button[contains(normalize-space(.), 'Apply Filter')]][1]`
  );
  await panel.waitFor({ state: 'visible', timeout: 20000 });
  return panel;
}

async function pickDate(page, dialog, labelText, isoDate) {
  const field = /from/i.test(labelText)
    ? dialog.locator(L.dateFrom).first()
    : dialog.locator(L.dateTo).first();
  await field.waitFor({ state: 'visible', timeout: 20000 });
  await field.click();

  const calendar = page.locator('[data-slot="calendar"].rdp-root, .rdp-root, [data-slot="calendar"]').first();
  await calendar.waitFor({ state: 'visible', timeout: 20000 });
  const caption = calendar.locator('.rdp-caption_label').first();
  const previous = calendar.locator('button.rdp-button_previous, .rdp-button_previous').first();
  const next = calendar.locator('button.rdp-button_next, .rdp-button_next').first();
  await caption.waitFor({ state: 'visible', timeout: 8000 });

  const monthNumbers = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const [year, month] = isoDate.split('-').map(Number);
  const target = new Date(year, month - 1, 1);

  for (let attempt = 0; attempt < 36; attempt++) {
    const [monthName, captionYear] = (await caption.innerText()).trim().split(/\s+/);
    const current = new Date(Number(captionYear), monthNumbers[monthName.toLowerCase()], 1);
    if (current.getFullYear() === target.getFullYear() && current.getMonth() === target.getMonth()) break;
    await (current > target ? previous : next).click();
    await page.waitForTimeout(80);
  }

  const day = calendar.locator(`td[data-day="${isoDate}"] button`).first();
  await day.waitFor({ state: 'visible', timeout: 20000 });
  await day.click();
  await page.waitForTimeout(200);
}

async function applyRoundFilter(page, dialog, roundNumber) {
  const target = dashboardRound(roundNumber);
  const label = dialog.locator('label').filter({ hasText: /^Round$/i }).first();
  let trigger = label.locator('xpath=following-sibling::button[@role="combobox"][1]');
  if (!(await trigger.count().catch(() => 0))) {
    trigger = dialog.locator('button[role="combobox"]').filter({ hasText: /^Select Round$/i }).first();
  }
  await trigger.waitFor({ state: 'visible', timeout: 15000 });
  await trigger.click();

  let option = page.getByRole('option', {
    name: new RegExp(`^${escapeRegExp(target)}$`, 'i'),
  }).last();
  if (!(await option.count().catch(() => 0))) {
    option = page.locator('[data-radix-collection-item]').filter({
      hasText: new RegExp(`^${escapeRegExp(target)}$`, 'i'),
    }).last();
  }
  await option.waitFor({ state: 'visible', timeout: 15000 });
  await option.click();
  await page.waitForTimeout(250);
  console.log(`[FILTER] Round ${roundNumber} -> ${target}`);
}

async function applyGroupFilter(page, dialog, groupName) {
  let trigger = dialog.locator(L.groupFilterBtn).filter({ hasText: /Filter by group/i }).first();
  if (!(await trigger.count().catch(() => 0))) {
    trigger = dialog.getByRole('button', { name: /Filter by group/i }).first();
  }
  await trigger.waitFor({ state: 'visible', timeout: 15000 });
  await trigger.click();
  await page.locator('[cmdk-item], [role="option"]').first().waitFor({ state: 'visible', timeout: 15000 });

  const selected = await page.evaluate(async (targetText) => {
    const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const wanted = normalize(targetText);
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = () => [...document.querySelectorAll('[cmdk-item][role="option"], [cmdk-item], [role="option"]')]
      .filter(visible);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let scroller = items()[0] || null;
    while (scroller?.parentElement) {
      const parent = scroller.parentElement;
      const style = getComputedStyle(parent);
      if (parent.scrollHeight > parent.clientHeight + 20 && ['auto', 'scroll'].includes(style.overflowY)) {
        scroller = parent;
        break;
      }
      scroller = parent;
    }

    let lastTop = -1;
    let examples = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      const visibleItems = items();
      examples = visibleItems.map((item) => item.querySelector('span')?.textContent?.trim() || item.textContent?.trim() || '').filter(Boolean);
      const match = visibleItems.find((item) => {
        const span = normalize(item.querySelector('span')?.textContent || '');
        const full = normalize(item.textContent || '');
        return span === wanted || full === wanted;
      });
      if (match) {
        match.click();
        return { found: true, label: match.textContent?.trim() || '' };
      }
      if (!(scroller instanceof HTMLElement) || scroller.scrollTop === lastTop) break;
      lastTop = scroller.scrollTop;
      scroller.scrollTop += Math.max(220, Math.floor(scroller.clientHeight * 0.8));
      await sleep(120);
    }
    return { found: false, examples: examples.slice(0, 25) };
  }, groupName);

  if (!selected?.found) {
    const examples = selected?.examples?.length ? ` Examples: ${selected.examples.join(', ')}` : '';
    throw new Error(`Group option "${groupName}" was not found.${examples}`);
  }
  await page.waitForTimeout(300);
  console.log(`[FILTER] Group -> ${groupName}`);
}

async function applyFiltersThroughUi(page, config) {
  console.log('[NAVIGATE] Opening the plain Sessions page...');
  await page.goto(SESSIONS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  console.log('[FILTER] Clicking Filter and using the dashboard controls...');
  let dialog = await openFilterDialog(page);
  await pickDate(page, dialog, 'Date From', config.dateFrom);
  if (!(await dialog.isVisible().catch(() => false))) {
    dialog = await openFilterDialog(page);
    await pickDate(page, dialog, 'Date From', config.dateFrom);
  }
  await pickDate(page, dialog, 'Date To', config.dateTo);
  await applyRoundFilter(page, dialog, config.roundFilter);
  await applyGroupFilter(page, dialog, config.groupFilter);

  const apply = dialog.getByRole('button', { name: /Apply Filter/i });
  await Promise.all([
    page.waitForLoadState('networkidle'),
    apply.click(),
  ]);
  await page.waitForTimeout(900);
  console.log(`[FILTER] Applied through UI. Dashboard URL: ${page.url()}`);
}

async function fetchFilteredSessionsFromApi(page, capturedUrl, headers, config) {
  if (!capturedUrl || !headers) {
    throw new Error('The filtered Sessions API response was not captured after Apply Filter.');
  }

  // Keep every filter generated by the dashboard UI. Removing only `page`
  // starts from the API's canonical first page and prevents the page=1 skip.
  const firstUrl = new URL(String(capturedUrl).replace('http://', 'https://'));
  firstUrl.searchParams.delete('page');
  const rows = [];
  let next = firstUrl.toString();
  const visited = new Set();

  while (next && !visited.has(next)) {
    visited.add(next);
    const response = await page.request.get(String(next).replace('http://', 'https://'), { headers });
    if (!response.ok()) throw new Error(`Sessions API returned ${response.status()} for ${next}`);
    const payload = await response.json();
    rows.push(...(payload.data || []));
    next = payload.pagination?.next || null;
  }

  const byId = new Map();
  for (const raw of rows) {
    const id = String(raw?.id || '').trim();
    const group = String(raw?.group?.label || '').trim();
    const dateRaw = [
      raw?.start_datetime, raw?.start_date_time, raw?.starts_at, raw?.start_at,
      raw?.scheduled_at, raw?.datetime, raw?.date_time, raw?.date,
    ].map((value) => String(value || '')).find((value) => /\d{4}-\d{2}-\d{2}/.test(value)) || '';
    const date = normalizeDate(dateRaw);
    if (!id || group !== config.groupFilter || !date || date < config.dateFrom || date > config.dateTo) continue;
    byId.set(id, {
      id,
      group,
      date,
      time: String(dateRaw).match(/\b\d{1,2}:\d{2}\b/)?.[0] || '',
      name: String(raw?.name || '').trim(),
      deliveryMode: String(raw?.delivery_mode || '').trim(),
    });
  }

  console.log(`[API] Collected ${byId.size} unique filtered sessions across ${visited.size} API page(s).`);
  return byId;
}

async function waitForPopulatedRows(page) {
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    if (!rows.length) return false;
    return rows.some((row) => row.querySelector('td'));
  }, null, { timeout: 20000 });
}

function normalizeDate(value) {
  const match = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : '';
}

async function collectCurrentPageSessions(page, expectedById, seenIds) {
  const rows = page.locator(L.rows);
  const sessions = [];
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const href = await row.locator('td:first-child a').first().getAttribute('href').catch(() => '');
    const id = String(href || '').match(/\/([^/?#]+)(?:[?#]|$)/)?.[1] || '';
    if (!id || seenIds.has(id) || !expectedById.has(id)) continue;
    seenIds.add(id);
    sessions.push(expectedById.get(id));
  }
  return sessions;
}

async function findSessionRow(page, sessionId) {
  const candidates = page.locator(`table tbody tr:has(a[href$="/${sessionId}"])`);
  for (let index = 0; index < await candidates.count(); index++) {
    const row = candidates.nth(index);
    const menu = row.locator('[aria-haspopup="menu"]').first();
    if (await row.isVisible().catch(() => false) && await menu.count()) return row;
  }
  return null;
}

async function openEditDialog(page, row) {
  await row.locator('[aria-haspopup="menu"]').first().click();
  let edit = page.getByRole('menuitem', { name: 'Edit', exact: true }).first();
  if (!(await edit.count().catch(() => 0))) edit = page.getByText('Edit', { exact: true }).first();
  await edit.click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Edit Session' }).first();
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await dialog.locator('#link').waitFor({ state: 'visible', timeout: 10000 });
  return dialog;
}

async function closeEditDialog(page, dialog) {
  const close = dialog.getByRole('button', { name: 'Close' }).first();
  if (await close.count().catch(() => 0)) await close.click().catch(() => {});
  if (await dialog.isVisible().catch(() => false)) await page.keyboard.press('Escape').catch(() => {});
}

async function editOneVisibleSession(page, config, session) {
  let row = await findSessionRow(page, session.id);
  if (!row) throw new Error('The filtered session row is no longer visible.');

  console.log('[ACTION] Three dots -> Edit');
  let dialog = await openEditDialog(page, row);
  const input = dialog.locator('#link');
  const oldLink = (await input.inputValue()).trim();
  if (oldLink === config.newLink) {
    await closeEditDialog(page, dialog);
    return { status: 'already_current', oldLink };
  }
  if (DRY_RUN) {
    await closeEditDialog(page, dialog);
    return { status: 'dry_run', oldLink };
  }

  await input.fill(config.newLink);
  await dialog.getByRole('button', { name: 'Update Session', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 20000 });
  await page.waitForTimeout(600);

  row = await findSessionRow(page, session.id);
  if (!row) throw new Error('Updated row disappeared before verification.');
  dialog = await openEditDialog(page, row);
  const savedLink = (await dialog.locator('#link').inputValue()).trim();
  await closeEditDialog(page, dialog);
  if (savedLink !== config.newLink) throw new Error(`Verification failed; saved value is "${savedLink}".`);
  return { status: 'updated', oldLink };
}

async function firstRowSignature(page) {
  return page.locator('table tbody tr').first().innerText().catch(() => '');
}

async function clickNextPageThroughUi(page) {
  const before = await firstRowSignature(page);
  const clicked = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const enabled = (element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    const controls = [...document.querySelectorAll('a, button')].filter((element) => visible(element) && enabled(element));
    let next = controls.find((element) => {
      const text = (element.textContent || '').trim();
      const label = element.getAttribute('aria-label') || '';
      return element.getAttribute('rel') === 'next' || /^next$/i.test(text) || /next\s*page/i.test(label);
    });
    if (!next) {
      const current = Number(new URL(location.href).searchParams.get('page') || 0);
      const candidates = controls
        .filter((element) => element.tagName === 'A' && element.href)
        .map((element) => ({ element, page: Number(new URL(element.href).searchParams.get('page')) }))
        .filter((entry) => Number.isFinite(entry.page) && entry.page > current)
        .sort((a, b) => a.page - b.page);
      next = candidates[0]?.element;
    }
    if (!next) return false;
    next.click();
    return true;
  });
  if (!clicked) return false;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction((previous) => {
    const first = document.querySelector('table tbody tr');
    return first && first.innerText !== previous;
  }, before, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeReport(rows) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '_');
  const reportPath = path.join(EXPORT_DIR, `dashboard_link_edit_report_${stamp}.csv`);
  const fields = ['group', 'date', 'time', 'name', 'session_id', 'status', 'old_link', 'new_link', 'reason'];
  const lines = [fields.join(',')];
  for (const row of rows) lines.push(fields.map((field) => csvEscape(row[field])).join(','));
  fs.writeFileSync(reportPath, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  return reportPath;
}

(async () => {
  const config = readConfig();
  validateConfig(config);
  console.log(`[START] Dashboard link edit${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`Group: ${config.groupFilter}`);
  console.log(`Date range: ${config.dateFrom} -> ${config.dateTo}`);

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();
  const reportRows = [];
  const seenIds = new Set();
  let sessionsApiUrl = '';
  let sessionsApiHeaders = null;
  page.on('response', (response) => {
    if (/\/api\/v1\/admin\/sessions\//.test(response.url())) {
      sessionsApiUrl = response.url();
      sessionsApiHeaders = response.request().headers();
    }
  });

  try {
    console.log('[LOGIN] Using the same dashboard login flow...');
    await page.goto(LOGIN_URL);
    await page.fill('input[type="email"]', process.env.LOGIN_EMAIL);
    await page.fill('#password', process.env.LOGIN_PASSWORD);
    await page.click('button:has-text("Login")');
    await page.waitForLoadState('networkidle');
    console.log('[OK] Logged in');

    await applyFiltersThroughUi(page, config);
    const expectedById = await fetchFilteredSessionsFromApi(
      page,
      sessionsApiUrl,
      sessionsApiHeaders,
      config
    );
    if (!expectedById.size) throw new Error('The filtered API returned no matching sessions.');

    // This is the same correction used by Run Attendance: Apply Filter leaves
    // the dashboard on page=1 although pagination is zero-based. The dashboard
    // UI has already generated every filter value; change only the page index.
    const firstFilteredPage = new URL(page.url());
    firstFilteredPage.searchParams.delete('page');
    if (page.url() !== firstFilteredPage.toString()) {
      await page.goto(firstFilteredPage.toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle');
    }
    await waitForPopulatedRows(page);

    for (let pageNumber = 1; pageNumber <= 200; pageNumber++) {
      const sessions = await collectCurrentPageSessions(page, expectedById, seenIds);
      console.log(`[PAGE ${pageNumber}] matched rows=${sessions.length}`);

      for (const session of sessions) {
        if (session.deliveryMode.toLowerCase() !== 'live') {
          console.log(`[SKIP] ${session.date} | ${session.name} | ${session.deliveryMode || 'not live'}`);
          reportRows.push({
            ...session,
            session_id: session.id,
            status: 'skipped_physical',
            old_link: '',
            new_link: config.newLink,
            reason: `Delivery mode is ${session.deliveryMode || 'not live'}`,
          });
          continue;
        }

        let result;
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            result = await editOneVisibleSession(page, config, session);
            break;
          } catch (error) {
            lastError = error;
            console.log(`[RETRY] ${session.id} attempt ${attempt}/3: ${error.message}`);
            await page.keyboard.press('Escape').catch(() => {});
            if (attempt < 3) await page.waitForTimeout(900 * attempt);
          }
        }
        reportRows.push({
          ...session,
          session_id: session.id,
          status: result?.status || 'failed',
          old_link: result?.oldLink || '',
          new_link: config.newLink,
          reason: result ? '' : (lastError?.message || 'Unknown error'),
        });
        console.log(result ? `[OK] ${result.status}: ${session.id}` : `[FAILED] ${session.id}: ${lastError?.message}`);
      }

      if (seenIds.size >= expectedById.size) break;
      if (!(await clickNextPageThroughUi(page))) break;
    }

    const missingIds = [...expectedById.keys()].filter((id) => !seenIds.has(id));
    if (missingIds.length) {
      for (const id of missingIds) {
        const session = expectedById.get(id);
        reportRows.push({
          ...session,
          session_id: id,
          status: 'failed',
          old_link: '',
          new_link: config.newLink,
          reason: 'API found this session, but its row was not reached through dashboard pagination.',
        });
      }
      throw new Error(`Coverage check failed: ${missingIds.length} API session row(s) were not reached.`);
    }
  } finally {
    const reportPath = writeReport(reportRows);
    console.log(`[REPORT] ${reportPath}`);
    await browser.close().catch(() => {});
  }

  const count = (status) => reportRows.filter((row) => row.status === status).length;
  console.log(`[SUMMARY] updated=${count('updated')}, already_current=${count('already_current')}, dry_run=${count('dry_run')}, skipped_physical=${count('skipped_physical')}, failed=${count('failed')}`);
  if (count('failed')) process.exitCode = 1;
})().catch((error) => {
  console.error(`[FATAL] ${error.stack || error.message}`);
  process.exit(1);
});
