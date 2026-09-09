require('dotenv').config();
const { chromium } = require('playwright');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { GROUP_BATCHES } = require('./group_batches');
const {
  getGroupCategory,
  matchesTrack,
  normalizeTrack,
  trackLabel,
  TRACK_ALL,
  TRACK_TECHNICAL,
  TRACK_NON_TECHNICAL,
} = require('./group_tracks');
const { resolveGroupsWorkbookPath } = require('./group_workbook');
const { attendanceConsoleScript } = require('./attendance_console_script');

/* =======================
   SETTINGS
======================= */

// Read config from command line arguments or use defaults
let configFile = null;
let configArg = process.argv.indexOf('--config');
if (configArg !== -1 && process.argv[configArg + 1]) {
  configFile = process.argv[configArg + 1];
}

let DATE_FROM = '2026-05-02';
let DATE_TO = '2026-05-15';
let GROUP_FILTER = '';
let ROUND_FILTER = '';
let BATCH_FILTER = '';
let TRACK_FILTER = TRACK_ALL;

if (configFile && fs.existsSync(configFile)) {
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    if (config.dateFrom) DATE_FROM = config.dateFrom;
    if (config.dateTo) DATE_TO = config.dateTo;
    if (config.groupFilter) GROUP_FILTER = String(config.groupFilter).trim();
    if (config.roundFilter) ROUND_FILTER = String(config.roundFilter).trim();
    if (config.batchFilter) BATCH_FILTER = String(config.batchFilter).trim().toLowerCase();
    if (config.trackFilter) TRACK_FILTER = normalizeTrack(config.trackFilter);
    console.log(`✅ تم تحميل التكوين من: ${configFile}`);
    console.log(`📅 من: ${DATE_FROM} إلى: ${DATE_TO}`);
  } catch (e) {
    console.log(`⚠️ خطأ في قراءة الملف: ${e.message}`);
  }
}

const EMAIL = process.env.LOGIN_EMAIL;
const PASSWORD = process.env.LOGIN_PASSWORD;

const LOGIN_URL = 'https://dashboard.depi.eyouthbusiness.com/auth/login';
const SESSIONS_URL = 'https://dashboard.depi.eyouthbusiness.com/super_admin/sessions';

const EXPORT_DIR = './exports';
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

const BATCH_GROUPS = new Set(GROUP_BATCHES[BATCH_FILTER] || []);

/* =======================
   EXTRA WAITS
======================= */
const WAIT_AFTER_CSV_DOWNLOAD_MS = 1200;
const WAIT_BETWEEN_SESSIONS_MS   = 600;
const WAIT_AFTER_NEXT_PAGE_MS    = 300;
const DOWNLOAD_EVENT_TIMEOUT_MS  = 120000;

/* =======================
   HELPERS
======================= */

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const safe = (s) => String(s || 'UNKNOWN').replace(/[^\w]+/g, '_');

function assertIsoDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`Invalid date format "${d}". Use YYYY-MM-DD`);
  }
}

function compareIso(a, b) {
  return a.localeCompare(b);
}

function nowISO() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function appendFileWithRetry(filePath, content, retries = 6, delay = 400) {
  let lastErr;

  for (let i = 0; i < retries; i++) {
    try {
      fs.appendFileSync(filePath, content, 'utf-8');
      return;
    } catch (err) {
      lastErr = err;

      if (err.code !== 'EBUSY' && err.code !== 'EPERM') {
        throw err;
      }

      await sleep(delay);
    }
  }

  throw lastErr;
}

async function writeFileWithRetry(filePath, content, retries = 6, delay = 400) {
  let lastErr;

  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      return;
    } catch (err) {
      lastErr = err;

      if (err.code !== 'EBUSY' && err.code !== 'EPERM') {
        throw err;
      }

      await sleep(delay);
    }
  }

  throw lastErr;
}

function ensureCategoryGroupDir(group) {
  const category = getGroupCategory(group);
  const dir = path.join(EXPORT_DIR, category, safe(group));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureCategoryTitlesDir(group) {
  const category = getGroupCategory(group);
  const dir = path.join(EXPORT_DIR, category, 'CSV Titles');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getExpectedCsvPath(group, fileBase) {
  const groupDir = ensureCategoryGroupDir(group);
  return path.join(groupDir, `${fileBase}.csv`);
}

/* =======================
   Finished titles per group
   - exports/<CATEGORY>/CSV Titles/<GROUP_NAME>.csv
   - columns: sessionUrl,title
======================= */

function mapMode(modeRaw) {
  const m = normalize(modeRaw);
  if (m === 'live') return 'Online';
  if (m.includes('physical') || m.includes('onsite') || m.includes('on site')) return 'Physical';
  if (!modeRaw) return 'Online';
  return String(modeRaw).trim();
}

function extractTimeHHMM(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  // Check 12-hour values first so "9:00 pm" is not mistaken for 09:00.
  let m = text.match(/\b(1[0-2]|0?[1-9]):([0-5]\d)\s*([ap]m)\b/i);
  if (m) {
    let hour = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') hour += 12;
    return `${String(hour).padStart(2, '0')}:${m[2]}`;
  }

  // 24-hour values such as 09:00, 14:30, 2026-08-13T21:00:00Z.
  m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  }

  return '';
}

function getApiSessionDateTimeRaw(session) {
  if (!session || typeof session !== 'object') return '';

  // Prefer fields that already contain the full scheduled datetime.
  const directCandidates = [
    session.start_datetime,
    session.start_date_time,
    session.starts_at,
    session.start_at,
    session.scheduled_at,
    session.datetime,
    session.date_time,
    session.dateTime,
    session.session_datetime,
    session.sessionDateTime,
    session.date,
  ];

  for (const value of directCandidates) {
    const text = String(value || '').trim();
    if (/\d{4}-\d{2}-\d{2}/.test(text) && extractTimeHHMM(text)) {
      return text;
    }
  }

  // Some API versions split the date and the start time into two fields.
  const dateCandidates = [
    session.date,
    session.session_date,
    session.start_date,
    session.sessionDate,
  ];
  const timeCandidates = [
    session.start_time,
    session.startTime,
    session.time_from,
    session.from_time,
    session.session_time,
    session.sessionTime,
    session.time,
  ];

  const dateValue = dateCandidates
    .map((value) => String(value || '').trim())
    .find((value) => /\d{4}-\d{2}-\d{2}/.test(value));
  const timeValue = timeCandidates
    .map((value) => String(value || '').trim())
    .find((value) => extractTimeHHMM(value));

  if (dateValue && timeValue) {
    return `${dateValue.slice(0, 10)} ${extractTimeHHMM(timeValue)}`;
  }

  return dateValue || '';
}

function formatFinishedTitle({ sessionNameRaw, sessionDateRaw, modeRaw, typeRaw }) {
  const sessionName = String(sessionNameRaw || '').trim();
  const rawDateTime = String(sessionDateRaw || '').trim();

  const dateMatch = rawDateTime.match(/(\d{4}-\d{2}-\d{2})/);
  const isoDate = dateMatch ? dateMatch[1] : '';
  const hhmm = extractTimeHHMM(rawDateTime);

  // Never silently invent midnight. That was the reason every generated LMS
  // session became 12:00 am -> 3:00 am when API discovery passed only YYYY-MM-DD.
  if (!isoDate || !hhmm) {
    console.log(
      `⚠️ Cannot build finished title without the real session date/time: ` +
      `name="${sessionName}" raw="${rawDateTime}"`
    );
    return '';
  }

  const start = new Date(`${isoDate}T${hhmm}:00`);
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);

  const dateStr = start
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    .replace(' ', '-');

  const fmtTime = (d) =>
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();

  const mode = mapMode(modeRaw);
  const type = (typeRaw || '').trim();

  return `${sessionName} | ${dateStr} | ${mode} | ${type} |  | ${fmtTime(start)} - ${fmtTime(end)}`;
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const finishedTitlesByGroup = new Map();

async function appendFinishedTitleToGroup(group, sessionUrl, title) {
  if (!group || !sessionUrl || !title) return;

  const groupKey = safe(group);
  const titlesDir = ensureCategoryTitlesDir(group);
  const filePath = path.join(titlesDir, `${groupKey}.csv`);

  if (!finishedTitlesByGroup.has(groupKey)) {
    const titleMap = new Map();

    if (fs.existsSync(filePath)) {
      try {
        const existingWb = XLSX.readFile(filePath);
        const sheet = existingWb.Sheets[existingWb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        for (const row of rows) {
          const url = String(row.sessionUrl || row.SessionURL || row.url || '').trim();
          const existingTitle = String(row.title || row.Title || '').trim();
          if (url) titleMap.set(url, existingTitle);
        }
      } catch (error) {
        console.log(`⚠️ Could not parse existing titles CSV ${filePath}: ${error.message}`);
      }
    } else {
      await writeFileWithRetry(filePath, 'sessionUrl,title\r\n');
    }

    finishedTitlesByGroup.set(groupKey, titleMap);
  }

  const titleMap = finishedTitlesByGroup.get(groupKey);
  const previousTitle = titleMap.get(sessionUrl);

  // Same URL + same title: nothing to do.
  if (previousTitle === title) return;

  titleMap.set(sessionUrl, title);

  if (previousTitle == null) {
    const line = `${csvEscape(sessionUrl)},${csvEscape(title)}\r\n`;
    await appendFileWithRetry(filePath, line);
    return;
  }

  // Important repair behavior: older runs may already contain the bad
  // 12:00 am -> 3:00 am title for this same sessionUrl. Rewrite that row
  // instead of skipping it forever just because the URL was seen before.
  const csvContent = [
    'sessionUrl,title',
    ...[...titleMap.entries()].map(([url, storedTitle]) =>
      `${csvEscape(url)},${csvEscape(storedTitle)}`
    ),
  ].join('\r\n') + '\r\n';

  await writeFileWithRetry(filePath, csvContent);
  console.log(`♻️ Updated existing finished title for ${group}: ${sessionUrl}`);
}

/* =======================
   Attendance state
======================= */
async function getAttendanceState(detailPage) {
  const cand1 = detailPage.locator(
    `xpath=//*[normalize-space(.)='Attendance:' or contains(normalize-space(.),'Attendance')]/following::*[1]`
  ).first();

  const cand2 = detailPage.locator(
    `xpath=//*[contains(normalize-space(.),'Attendance')]/following-sibling::*[1]`
  ).first();

  const txt1 = (await cand1.innerText().catch(() => '')) || '';
  const txt2 = (await cand2.innerText().catch(() => '')) || '';

  const txt = txt1.trim() ? txt1 : txt2;
  return normalize(txt);
}

/* =======================
   LMS missing names CSV
======================= */

function findRosterEmailForName(name, rosterText) {
  const rawName = String(name || '').trim();
  const directEmail = rawName.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (directEmail) return directEmail.toLowerCase();

  const wanted = normalize(rawName);
  if (!wanted) return '';

  const rosterRows = String(rosterText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts =
        line.includes('\t') ? line.split('\t') :
        line.includes(',') ? line.split(',') :
        line.split(/\s{2,}/);
      return {
        name: String(parts[0] || '').trim(),
        email: String(parts[1] || '').trim(),
      };
    });

  const exact = rosterRows.find((row) => normalize(row.name) === wanted);
  return exact?.email || '';
}

async function writeLmsMissingNamesCsv(missingNames, outDir) {
  if (!missingNames || missingNames.length === 0) return null;

  const outPath = path.join(outDir, 'Lms missing names.csv');
  const byNameAndGroup = new Map();

  if (fs.existsSync(outPath)) {
    try {
      const existingWb = XLSX.readFile(outPath);
      const existingRows = XLSX.utils.sheet_to_json(
        existingWb.Sheets[existingWb.SheetNames[0]]
      );
      for (const row of existingRows) {
        const normalized = {
          name: String(row.name || row.Name || '').trim(),
          email: String(row.email || row.Email || '').trim(),
          group: String(row.group || row.Group || '').trim(),
        };
        if (!normalized.name) continue;
        const key = `${normalize(normalized.name)}||${normalize(normalized.group)}`;
        byNameAndGroup.set(key, normalized);
      }
    } catch (error) {
      console.log(`⚠️ Could not read existing Lms missing names.csv: ${error.message}`);
    }
  }

  for (const item of missingNames) {
    const obj = typeof item === 'string'
      ? { name: item, email: '', group: '' }
      : item;
    const normalized = {
      name: String(obj.name || '').trim(),
      email: String(obj.email || '').trim(),
      group: String(obj.group || '').trim(),
    };
    if (!normalized.name) continue;

    const key = `${normalize(normalized.name)}||${normalize(normalized.group)}`;
    const existing = byNameAndGroup.get(key);
    if (!existing || (!existing.email && normalized.email)) {
      byNameAndGroup.set(key, normalized);
    }
  }

  const rows = [...byNameAndGroup.values()].sort((a, b) =>
    a.group.localeCompare(b.group) || a.name.localeCompare(b.name)
  );
  const csvContent = '\ufeff' + [
    ['name', 'email', 'group'],
    ...rows.map((row) => [row.name, row.email, row.group]),
  ]
    .map((columns) => columns.map(csvEscape).join(','))
    .join('\r\n');

  await writeFileWithRetry(outPath, csvContent);
  return outPath;
}

/* =======================
   Skipped sessions Excel
======================= */

function writeSkippedExcel(skipped, outDir, dateFrom, dateTo) {
  if (!skipped || skipped.length === 0) return null;

  const rows = skipped.map((x, idx) => ({
    '#': idx + 1,
    Date: x.date || '',
    Group: x.group || '',
    Topic: x.topic || '',
    Status: x.status || '',
    Reason: x.reason || '',
    Page: x.page ?? '',
    SessionURL: x.sessionUrl || '',
    Time: x.time || '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows, { skipHeader: false });

  ws['!cols'] = [
    { wch: 4 },
    { wch: 12 },
    { wch: 28 },
    { wch: 40 },
    { wch: 12 },
    { wch: 32 },
    { wch: 6 },
    { wch: 60 },
    { wch: 19 },
  ];

  const lastCol = 'I';
  const lastRow = rows.length + 1;
  ws['!autofilter'] = { ref: `A1:${lastCol}${lastRow}` };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Skipped Sessions');

  const fileName = `skipped_sessions_${safe(dateFrom)}_to_${safe(dateTo)}.xlsx`;
  const outPath = path.join(outDir, fileName);
  XLSX.writeFile(wb, outPath);

  return outPath;
}

/* =======================
   LOCATORS
======================= */

const L = {
  email: 'input[type="email"]',
  password: '#password',
  loginBtn: 'button:has-text("Login")',

  filterBtn: 'button[data-slot="dialog-trigger"]:has-text("Filter")',
  filterDialog: '[role="dialog"][data-slot="dialog-content"]',
  groupFilterBtn: 'button[data-slot="popover-trigger"]:has-text("Filter by group")',
  dateFrom: '#date_from',
  dateTo: '#date_to',

  rows: 'table tbody tr',
  sessionLink: 'td:first-child a',

  viewDetails: 'button:has-text("View details")',
  attendanceDialog: '[role="dialog"]',
};

/* =======================
   PAGINATION
======================= */

function getPageNumberFromUrl(u) {
  const url = new URL(u);
  // The dashboard is zero-based: the first page has no query parameter,
  // the second page is ?page=1, the third is ?page=2, and so on.
  const raw = url.searchParams.get('page');
  if (raw == null || raw === '') return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function setPageNumberInUrl(u, pageNum) {
  const url = new URL(u);
  if (pageNum <= 0) {
    url.searchParams.delete('page');
  } else {
    url.searchParams.set('page', String(pageNum));
  }
  return url.toString();
}

async function getFirstRowSignature(page) {
  const rows = page.locator(L.rows);
  const count = await rows.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const href = await row.locator(L.sessionLink).getAttribute('href').catch(() => '');
    const date = await row.locator('td:nth-child(3)').innerText().catch(() => '');
    const group = await row.locator('td:nth-child(4)').innerText().catch(() => '');
    if ((date || '').trim() && (group || '').trim()) {
      return `${href || ''}||${date.trim()}||${group.trim()}`;
    }
  }
  return null;
}

async function waitForSessionRowsReady(page, timeout = 12000) {
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('table tbody tr')].some((row) => {
      const cells = row.querySelectorAll('td');
      const date = cells[2]?.textContent?.trim();
      const group = cells[3]?.textContent?.trim();
      return Boolean(date && group);
    });
  }, null, { timeout }).catch(() => {});
}

async function tryGotoNextPageByUi(page, beforeSig, curPage) {
  const curUrl = page.url();
  const clicked = await page.evaluate(() => {
    const norm = (s) => String(s || '').trim().toLowerCase();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        cs.display !== 'none' &&
        cs.visibility !== 'hidden';
    };
    const isDisabled = (el) =>
      el.hasAttribute('disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      !!el.closest('[aria-disabled="true"]');

    const score = (el) => {
      const text = norm(el.textContent);
      const label = norm(el.getAttribute('aria-label'));
      const rel = norm(el.getAttribute('rel'));
      const inPagination = !!el.closest('nav,[class*="pagination"],[aria-label*="pagination" i]');

      if (rel === 'next') return inPagination ? 100 : 90;
      if (label.includes('next') || label.includes('التالي')) return inPagination ? 80 : 70;
      if (text === 'next' || text === 'التالي') return inPagination ? 60 : 50;
      return 0;
    };

    const candidates = [...document.querySelectorAll('a, button, [role="button"]')]
      .filter((el) => isVisible(el) && !isDisabled(el))
      .map((el) => ({ el, score: score(el) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) return false;
    candidates[0].el.click();
    return true;
  }).catch(() => false);

  if (!clicked) return false;

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await waitForSessionRowsReady(page);
  await page.waitForTimeout(WAIT_AFTER_NEXT_PAGE_MS);

  const newPage = getPageNumberFromUrl(page.url());
  const rowsCount = await page.locator(L.rows).count().catch(() => 0);
  if (rowsCount === 0) {
    await page.goto(curUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(WAIT_AFTER_NEXT_PAGE_MS);
    return false;
  }

  const afterSig = await getFirstRowSignature(page).catch(() => null);
  if (afterSig && beforeSig && afterSig !== beforeSig) {
    console.log(`➡️ Moved to next page via UI button (${curPage} -> ${newPage})`);
    return true;
  }

  await page.goto(curUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(WAIT_AFTER_NEXT_PAGE_MS);
  return false;
}

async function gotoNextPageByUrl(page, beforeSig = null, curPage = null) {
  const curUrl = page.url();
  if (curPage == null) curPage = getPageNumberFromUrl(curUrl);
  if (beforeSig == null) beforeSig = await getFirstRowSignature(page).catch(() => null);
  const nextUrl = setPageNumberInUrl(curUrl, curPage + 1);

  await page.goto(nextUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForSessionRowsReady(page);
  await page.waitForTimeout(WAIT_AFTER_NEXT_PAGE_MS);

  const newPage = getPageNumberFromUrl(page.url());
  if (newPage === curPage) return false;

  const rowsCount = await page.locator(L.rows).count().catch(() => 0);
  if (rowsCount === 0) {
    await page.goto(curUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(WAIT_AFTER_NEXT_PAGE_MS);
    return false;
  }

  const afterSig = await getFirstRowSignature(page).catch(() => null);
  if (beforeSig && afterSig && beforeSig === afterSig) {
    await page.goto(curUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(WAIT_AFTER_NEXT_PAGE_MS);
    return false;
  }

  return true;
}

async function gotoNextPage(page) {
  const curPage = getPageNumberFromUrl(page.url());
  const beforeSig = await getFirstRowSignature(page).catch(() => null);

  if (await tryGotoNextPageByUi(page, beforeSig, curPage)) {
    return true;
  }

  return gotoNextPageByUrl(page, beforeSig, curPage);
}

async function fetchSessionApiPayload(page, url, headers) {
  const response = await page.request.get(String(url).replace('http://', 'https://'), {
    headers: headers || {},
  });
  if (!response.ok()) {
    throw new Error(`Sessions API returned ${response.status()} for ${url}`);
  }
  return response.json();
}

async function fetchAllSessionApiRows(page, firstUrl, headers) {
  const firstUrlObject = new URL(firstUrl.replace('http://', 'https://'));
  firstUrlObject.searchParams.delete('page');
  firstUrlObject.searchParams.delete('group');
  const firstPayload = await fetchSessionApiPayload(page, firstUrlObject.toString(), headers);
  const firstRows = firstPayload.data || [];
  const total = Number(firstPayload.pagination?.count || firstRows.length);
  const pageSize = Math.max(1, firstRows.length || 20);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rows = [...firstRows];

  // Fetch page numbers in small parallel batches. The result is used only to
  // discover group UUIDs; session discovery itself is performed per group.
  for (let start = 2; start <= pageCount; start += 8) {
    const pageNumbers = Array.from(
      { length: Math.min(8, pageCount - start + 1) },
      (_, index) => start + index
    );
    const payloads = await Promise.all(pageNumbers.map((pageNumber) => {
      const url = new URL(firstUrlObject);
      url.searchParams.set('page', String(pageNumber));
      return fetchSessionApiPayload(page, url.toString(), headers);
    }));
    for (const payload of payloads) rows.push(...(payload.data || []));
  }
  return rows;
}

async function discoverSessionsReliablyViaApi({
  page,
  apiUrl,
  apiHeaders,
  groups,
  addSkip,
}) {
  if (!apiUrl || !apiHeaders) return null;

  console.log('⚡ Discovering sessions through the API per group...');
  const generalRows = await fetchAllSessionApiRows(page, apiUrl, apiHeaders);
  const groupIds = new Map();
  for (const session of generalRows) {
    const name = String(session.group?.label || '').trim();
    const value = String(session.group?.value || '').trim();
    if (name && value && !groupIds.has(name)) groupIds.set(name, value);
  }

  const rosterByGroup = new Map(
    groups.map((row) => [normalize(row.group), row])
  );
  const selectedGroups = [...groupIds.entries()].filter(([group]) => {
    if (!matchesTrack(group, TRACK_FILTER)) return false;
    if (GROUP_FILTER && normalize(group) !== normalize(GROUP_FILTER)) return false;
    if (BATCH_GROUPS.size && !BATCH_GROUPS.has(group)) return false;
    const groupRound = group.match(/^[A-Za-z]{3,4}([45])/)?.[1] || '';
    return !ROUND_FILTER || groupRound === ROUND_FILTER;
  });

  const groupResults = await Promise.all(selectedGroups.map(async ([group, groupId]) => {
    const url = new URL(apiUrl.replace('http://', 'https://'));
    url.searchParams.delete('page');
    url.searchParams.set('group', groupId);
    const rows = [];
    let next = url.toString();
    while (next) {
      const payload = await fetchSessionApiPayload(page, next, apiHeaders);
      rows.push(...(payload.data || []));
      next = payload.pagination?.next || null;
    }
    return rows;
  }));

  const byId = new Map();
  for (const session of groupResults.flat()) {
    if (session?.id) byId.set(session.id, session);
  }

  const discovered = [];
  for (const session of byId.values()) {
    const group = String(session.group?.label || '').trim();
    const focus = String(session.focus || '').trim().toLowerCase();
    if (TRACK_FILTER === TRACK_NON_TECHNICAL && focus !== 'soft_skill') continue;
    if (TRACK_FILTER === TRACK_TECHNICAL && focus !== 'technical') continue;
    if (!session.is_finished || normalize(session.status_by_trainer) !== 'finished') continue;

    const groupRow = rosterByGroup.get(normalize(group));
    const absUrl = `${SESSIONS_URL}/${session.id}`;
    const sessionDateTimeRaw = getApiSessionDateTimeRaw(session);
    const onlyDate = (
      String(sessionDateTimeRaw || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
      String(session.date || '').slice(0, 10)
    );
    const sessionTopic = focus === 'soft_skill'
      ? 'Soft Skill'
      : (focus === 'technical' ? 'Technical' : String(session.focus || 'Session'));

    if (!groupRow || !groupRow.roster) {
      addSkip({
        date: onlyDate,
        group,
        topic: sessionTopic,
        status: session.status_by_trainer || '',
        reason: 'No roster for group',
        pageNum: 'API',
        sessionUrl: absUrl,
      });
      continue;
    }

    // Keep the actual scheduled start time from the API. Passing `onlyDate`
    // here drops the time and previously forced every title to 00:00 -> 03:00.
    const finishedTitle = formatFinishedTitle({
      sessionNameRaw: session.name || '',
      sessionDateRaw: sessionDateTimeRaw,
      modeRaw: session.delivery_mode || '',
      typeRaw: sessionTopic,
    });
    if (finishedTitle) {
      await appendFinishedTitleToGroup(group, absUrl, finishedTitle);
    } else {
      console.log(
        `⚠️ Title not written because the API did not expose a usable start time: ` +
        `${group} | ${onlyDate} | session=${session.id}`
      );
    }

    const fileBase = `${safe(onlyDate)}_${safe(sessionTopic)}_${safe(group)}`.replace(/_+/g, '_');
    discovered.push({
      onlyDate,
      group,
      sessionTopic,
      statusText: 'Finished',
      absUrl,
      pageNum: 'API',
      fileBase,
      sessionId: session.id,
    });
  }

  console.log(`✅ Reliable API discovery found ${discovered.length} unique finished sessions.`);
  return discovered;
}

/* =======================
   PAGE CONSOLE SCRIPT
======================= */

function buildLegacyConsoleScript() {
  return async ({ rosterText, fileBase }) => {
    window.ROSTER = `
${String(rosterText || '').trim()}
`;
    console.log("✅ ROSTER loaded:", window.ROSTER.split(/\r?\n/).filter(Boolean).length, "rows");

    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const STATUS_MAP = { "Joined": "P", "Not-Joined": "A" };

      if (!window.ROSTER || !window.ROSTER.trim()) {
        console.error("❌ لازم تحط window.ROSTER الأول (Name<Tab>Email).");
        return;
      }

      const norm = (s) => (s || "")
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

      const tokenSet = (s) => new Set(norm(s).split(" ").filter(Boolean));
      const jaccard = (a, b) => {
        const A = tokenSet(a), B = tokenSet(b);
        if (!A.size || !B.size) return 0;
        let inter = 0;
        for (const x of A) if (B.has(x)) inter++;
        const union = A.size + B.size - inter;
        return union ? inter / union : 0;
      };

      const roster = window.ROSTER
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
          const parts =
            line.includes("\t") ? line.split("\t") :
            line.includes(",")  ? line.split(",")  :
            line.split(/\s{2,}/);

          const name = (parts[0] || "").trim();
          const email = (parts[1] || "").trim();
          return { name, email, n: norm(name) };
        })
        .filter(x => x.name && x.email);

      const exactMap = new Map();
      for (const r of roster) if (!exactMap.has(r.n)) exactMap.set(r.n, r.email);

      const dialog =
        [...document.querySelectorAll('[role="dialog"], [data-state="open"], .modal, .dialog')]
          .find(d => (d.innerText || '').includes('Attendance Details')) || document;

      const scrollables = [...dialog.querySelectorAll('*')].filter(el => {
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        const h = el.getBoundingClientRect().height;
        return (oy === 'auto' || oy === 'scroll') && h > 150;
      });
      const scroller = scrollables.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];

      if (!scroller) {
        console.warn("❌ مش لاقي جزء الليست اللي بيعمل Scroll. اضغط جوه الليست مرة وشغّل السكربت تاني.");
        return;
      }

      let lastTop = -1;
      for (let i = 0; i < 70; i++) {
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(110);
        if (scroller.scrollTop === lastTop) break;
        lastTop = scroller.scrollTop;
      }
      scroller.scrollTop = 0;
      await sleep(180);

      const statusEls = [...dialog.querySelectorAll('*')].filter(el => {
        const t = (el.textContent || '').trim();
        return t === 'Joined' || t === 'Not-Joined';
      });

      const extracted = [];
      const seenNames = new Set();

      for (const stEl of statusEls) {
        const statusText = stEl.textContent.trim();
        let rowEl = stEl;

        for (let k = 0; k < 10; k++) {
          rowEl = rowEl.parentElement;
          if (!rowEl) break;

          const lines = (rowEl.innerText || '')
            .split('\n').map(s => s.trim()).filter(Boolean);

          if (!lines.includes(statusText)) continue;

          const name = lines.find(x =>
            x !== 'Student' && x !== 'Status' && x !== 'Joined' && x !== 'Not-Joined'
          );

          if (name && name.length > 2) {
            const key = norm(name);
            if (!seenNames.has(key)) {
              seenNames.add(key);
              extracted.push({ name, statusText });
            }
            break;
          }
        }
      }

      if (extracted.length <= 2) {
        const textLines = (dialog.innerText || '')
          .split('\n').map(s => s.trim()).filter(Boolean)
          .filter(x => !['Attendance Details', 'Student', 'Status'].includes(x));

        const tmp = new Map();
        for (let i = 0; i < textLines.length - 1; i++) {
          const a = textLines[i], b = textLines[i + 1];
          if ((b === 'Joined' || b === 'Not-Joined') && a !== 'Joined' && a !== 'Not-Joined') {
            tmp.set(a, b);
          }
        }
        extracted.length = 0;
        for (const [name, statusText] of tmp.entries()) extracted.push({ name, statusText });
      }

      const rows = [];
      const missing = [];

      for (const rec of extracted) {
        const n = norm(rec.name);
        let email = exactMap.get(n);

        if (!email) {
          let best = null, bestScore = 0;
          for (const r of roster) {
            const s = jaccard(rec.name, r.name);
            if (s > bestScore) { bestScore = s; best = r; }
          }
          if (best && bestScore >= 0.75) email = best.email;
        }

        if (!email) {
          missing.push(rec.name);
          continue;
        }

        rows.push({
          user_identifier: email,
          status: STATUS_MAP[rec.statusText] || rec.statusText
        });
      }

      const base = String(fileBase || 'FILE').trim();
      const fileName = `${base}.csv`.replace(/\s+/g, "_");

      const csvEscapeLocal = (v) => {
        const s = String(v ?? "");
        if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };

      const csvLines = [
        ["user_identifier", "status"],
        ...rows
          .sort((a, b) => a.user_identifier.localeCompare(b.user_identifier))
          .map(r => [r.user_identifier, r.status])
      ].map(cols => cols.map(csvEscapeLocal).join(","));

      const csvContent = "\ufeff" + csvLines.join("\r\n");

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      console.log(`✅ Exported ${rows.length} rows to CSV. File="${fileName}"`);
      if (missing.length) console.warn("⚠️ Names not found in ROSTER:", missing);
    })();
  };
}

function buildConsoleScript() {
  return attendanceConsoleScript;
}

/* =======================
   FILTER HELPERS
======================= */

function getDateFieldKind(labelText) {
  const lower = String(labelText || '').toLowerCase();
  if (/date\s*from/i.test(lower)) return 'from';
  if (/date\s*to/i.test(lower)) return 'to';
  return '';
}

function normalizeDateTextToIso(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/);
  if (m) {
    const day = String(Number(m[1])).padStart(2, '0');
    const month = String(Number(m[2])).padStart(2, '0');
    return `${m[3]}-${month}-${day}`;
  }

  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };

  m = text.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    const month = months[m[1].toLowerCase()];
    if (month) {
      const day = String(Number(m[2])).padStart(2, '0');
      return `${m[3]}-${String(month).padStart(2, '0')}-${day}`;
    }
  }

  m = text.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (m) {
    const month = months[m[2].toLowerCase()];
    if (month) {
      const day = String(Number(m[1])).padStart(2, '0');
      return `${m[3]}-${String(month).padStart(2, '0')}-${day}`;
    }
  }

  return '';
}

async function resolveDateField(dlg, labelText) {
  const kind = getDateFieldKind(labelText);
  const directSelector =
    kind === 'from' ? L.dateFrom :
    kind === 'to' ? L.dateTo :
    '';

  if (directSelector) {
    const direct = dlg.locator(directSelector).first();
    if (await direct.count().catch(() => 0)) return direct;
  }

  const labelRe = new RegExp(labelText, "i");
  let field = dlg.getByLabel(labelRe).first();

  if (!(await field.count())) {
    field = dlg
      .locator(`xpath=.//*[contains(translate(normalize-space(.),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),
        '${labelText.toLowerCase()}')]/following::input[1]`)
      .first();
  }

  if (!(await field.count())) {
    field = dlg
      .locator(`xpath=.//*[contains(translate(normalize-space(.),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),
        '${labelText.toLowerCase()}')]/following::button[1]`)
      .first();
  }

  return field;
}

async function trySetDateFieldDirectly(dlg, labelText, isoDate) {
  const kind = getDateFieldKind(labelText);
  const selector =
    kind === 'from' ? L.dateFrom :
    kind === 'to' ? L.dateTo :
    '';

  if (!selector) return false;

  const field = dlg.locator(selector).first();
  if (!(await field.count().catch(() => 0))) return false;

  await field.evaluate((el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.setAttribute('value', value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, isoDate);
  return true;
}

async function readDateFieldIso(dlg, labelText) {
  const field = await resolveDateField(dlg, labelText);
  if (!(await field.count().catch(() => 0))) return '';

  const raw = await field.evaluate((el) => {
    const parts = [
      el.value,
      el.getAttribute?.('value'),
      el.getAttribute?.('aria-label'),
      el.textContent
    ].filter(Boolean);
    return parts.join(' | ');
  }).catch(() => '');

  return normalizeDateTextToIso(raw);
}

async function openFilterDialog(page) {
  let filterBtn = page.locator(L.filterBtn).filter({ hasText: /^Filter$/i }).last();
  if (!(await filterBtn.count().catch(() => 0))) {
    filterBtn = page.getByRole('button', { name: /^Filter$/i }).last();
  }

  await filterBtn.waitFor({ state: 'visible', timeout: 20000 });
  await filterBtn.click();

  const applyBtn = page.getByRole('button', {
    name: /^Apply Filter(?:\s*\(\d+\))?$/i
  }).first();
  await applyBtn.waitFor({ state: 'visible', timeout: 20000 });

  const roleDialog = page.locator(L.filterDialog).filter({ has: applyBtn }).first();
  if (
    await roleDialog.count().catch(() => 0) &&
    await roleDialog.isVisible().catch(() => false)
  ) {
    return roleDialog;
  }

  // The updated dashboard no longer consistently exposes role="dialog".
  // Anchor the filter panel to its unique heading and Apply Filter button.
  const panel = applyBtn.locator(
    `xpath=ancestor::*[
      self::div or self::section
    ][
      .//*[normalize-space(.)='Filter by']
      and .//button[contains(normalize-space(.), 'Apply Filter')]
    ][1]`
  );

  await panel.waitFor({ state: 'visible', timeout: 20000 });
  return panel;
}

function normalizeHeaderText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

async function getSessionTableColumns(page) {
  const headerTexts = await page
    .locator('table thead th')
    .allInnerTexts()
    .catch(() => []);

  const byName = new Map();
  headerTexts.forEach((text, index) => {
    const key = normalizeHeaderText(text);
    if (key && !byName.has(key)) byName.set(key, index + 1);
  });

  const column = (name, fallback) => byName.get(normalizeHeaderText(name)) || fallback;

  const columns = {
    name: column('Name', 1),
    date: column('Date', 3),
    group: column('Group', 4),
    type: column('Type', 5),
    topic: column('Topic', 6),
    status: column('Status', 7),
  };

  console.log('Session table columns:', columns);
  return columns;
}

async function readTableCell(row, columnNumber) {
  if (!columnNumber) return '';
  return (await row
    .locator(`td:nth-child(${columnNumber})`)
    .innerText()
    .catch(() => '')).trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function applyGroupFilter(page, dlg, groupName) {
  const target = String(groupName || '').trim();
  if (!target) return;

  console.log(`👥 Applying group filter: ${target}`);

  let trigger = dlg.locator(L.groupFilterBtn).filter({ hasText: /Filter by group/i }).first();
  if (!(await trigger.count().catch(() => 0))) {
    trigger = dlg.getByRole('button', { name: /Filter by group/i }).first();
  }

  await trigger.waitFor({ state: 'visible', timeout: 15000 });
  await trigger.click({ timeout: 8000 });

  const optionProbe = page.locator('[cmdk-item], [role="option"]').first();
  await optionProbe.waitFor({ state: 'visible', timeout: 15000 });

  const selection = await page.evaluate(async (targetText) => {
    const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const wanted = normalize(targetText);
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const getItems = () => [...document.querySelectorAll('[cmdk-item][role="option"], [cmdk-item], [role="option"]')]
      .filter((item) => isVisible(item));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const collectLabels = (items) => items
      .map((item) => item.querySelector('span')?.textContent?.trim() || item.textContent?.trim() || '')
      .filter(Boolean);

    const findMatch = (items) => {
      for (const item of items) {
        const spanText = normalize(item.querySelector('span')?.textContent || '');
        const fullText = normalize(item.textContent || '');
        if (spanText === wanted || fullText === wanted) {
          item.click();
          return {
            found: true,
            value: item.getAttribute('data-value') || '',
            label: item.querySelector('span')?.textContent?.trim() || item.textContent?.trim() || ''
          };
        }
      }
      return null;
    };

    const firstItem = getItems()[0];
    let scrollBox = firstItem || null;
    while (scrollBox && scrollBox.parentElement) {
      const parent = scrollBox.parentElement;
      if (parent.scrollHeight > parent.clientHeight + 20) {
        const style = window.getComputedStyle(parent);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollBox = parent;
          break;
        }
      }
      scrollBox = parent;
    }

    let lastScrollTop = -1;
    let seen = [];

    for (let attempt = 0; attempt < 80; attempt++) {
      const items = getItems();
      seen = collectLabels(items);

      const match = findMatch(items);
      if (match) return match;

      if (!scrollBox || !(scrollBox instanceof HTMLElement)) {
        break;
      }

      if (scrollBox.scrollTop === lastScrollTop) {
        break;
      }

      lastScrollTop = scrollBox.scrollTop;
      scrollBox.scrollTop += Math.max(220, Math.floor(scrollBox.clientHeight * 0.8));
      await sleep(120);
    }

    return {
      found: false,
      options: seen.slice(0, 40)
    };
  }, target);

  if (!selection?.found) {
    const sample = Array.isArray(selection?.options) && selection.options.length
      ? ` Available examples: ${selection.options.join(', ')}`
      : '';
    throw new Error(`Group option "${target}" was not found in dashboard filter list.${sample}`);
  }

  if (selection.value) {
    console.log(`🧷 Group id selected: ${selection.value}`);
  }

  await page.waitForTimeout(300);
}

async function applyRoundFilter(page, dlg, roundNumber) {
  const targetByRound = {
    '4': 'First',
    '5': 'Second',
  };

  const round = String(roundNumber || '').trim();
  const target = targetByRound[round];
  if (!target) return;

  console.log(`Applying dashboard round filter: Round ${round} -> ${target}`);

  const roundLabel = dlg.locator('label').filter({ hasText: /^Round$/i }).first();
  let trigger = roundLabel.locator(
    'xpath=following-sibling::button[@role="combobox"][1]'
  );

  if (!(await trigger.count().catch(() => 0))) {
    trigger = dlg
      .locator('button[role="combobox"]')
      .filter({ hasText: /^Select Round$/i })
      .first();
  }

  await trigger.waitFor({ state: 'visible', timeout: 15000 });
  await trigger.click();

  let option = page
    .getByRole('option', { name: new RegExp(`^${escapeRegExp(target)}$`, 'i') })
    .last();

  if (!(await option.count().catch(() => 0))) {
    option = page
      .locator('[data-radix-collection-item]')
      .filter({ hasText: new RegExp(`^${escapeRegExp(target)}$`, 'i') })
      .last();
  }

  await option.waitFor({ state: 'visible', timeout: 15000 });
  await option.click();
  await page.waitForTimeout(300);
}

async function pickDate(page, dlg, labelText, isoDate) {
  const labelRe = new RegExp(labelText, "i");

  let field = null;

  if (/date\s*from/i.test(labelText)) {
    const direct = dlg.locator(L.dateFrom).first();
    if (await direct.count().catch(() => 0)) field = direct;
  }

  if (!field && /date\s*to/i.test(labelText)) {
    const direct = dlg.locator(L.dateTo).first();
    if (await direct.count().catch(() => 0)) field = direct;
  }

  if (!field) {
    field = dlg.getByLabel(labelRe).first();
  }

  if (!(await field.count())) {
    field = dlg
      .locator(`xpath=.//*[contains(translate(normalize-space(.),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),
        '${labelText.toLowerCase()}')]/following::input[1]`)
      .first();
  }

  if (!(await field.count())) {
    field = dlg
      .locator(`xpath=.//*[contains(translate(normalize-space(.),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),
        '${labelText.toLowerCase()}')]/following::button[1]`)
      .first();
  }

  if (!(await field.count()) && /date\s*to/i.test(labelText)) {
    field = dlg.locator(L.dateTo).first();
  }

  await field.waitFor({ state: "visible", timeout: 20000 });
  await field.click({ timeout: 8000 });

  const calRoot = page
    .locator('[data-slot="calendar"].rdp-root, .rdp-root, [data-slot="calendar"]')
    .first();

  await calRoot.waitFor({ state: "visible", timeout: 20000 });

  const caption = calRoot.locator(".rdp-caption_label").first();
  await caption.waitFor({ state: "visible", timeout: 8000 });

  const prevBtn = calRoot.locator("button.rdp-button_previous, .rdp-button_previous").first();
  const nextBtn = calRoot.locator("button.rdp-button_next, .rdp-button_next").first();

  const [y, m] = isoDate.split("-").map(Number);
  const target = new Date(y, m - 1, 1);

  const monthIndex = (monName) => ({
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  })[(monName || "").toLowerCase()] ?? 0;

  const parseCaption = async () => {
    const text = (await caption.innerText()).trim();
    const [mon, yr] = text.split(/\s+/);
    return new Date(Number(yr), monthIndex(mon), 1);
  };

  for (let i = 0; i < 24; i++) {
    const cur = await parseCaption();
    if (cur.getFullYear() === target.getFullYear() && cur.getMonth() === target.getMonth()) break;

    if (cur > target) await prevBtn.click().catch(() => {});
    else await nextBtn.click().catch(() => {});

    await page.waitForTimeout(80);
  }

  const dayBtn = calRoot.locator(`td[data-day="${isoDate}"] button`).first();
  await dayBtn.waitFor({ state: "visible", timeout: 20000 });
  await dayBtn.click();

  if (/date\s*from/i.test(labelText) || /date\s*to/i.test(labelText)) {
    const verifyField = /date\s*from/i.test(labelText)
      ? dlg.locator(L.dateFrom).first()
      : dlg.locator(L.dateTo).first();

    if (await verifyField.count().catch(() => 0)) {
      const actual = await verifyField.inputValue().catch(() => '');
      if (actual && actual !== isoDate) {
        await verifyField.evaluate((el, value) => {
          el.value = value;
          el.setAttribute('value', value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, isoDate).catch(() => {});
      }
    }
  }

  await page.waitForTimeout(150);
}

async function setFilterDate(page, dlg, labelText, isoDate) {
  const directSet = await trySetDateFieldDirectly(dlg, labelText, isoDate).catch(() => false);
  if (!directSet) {
    await pickDate(page, dlg, labelText, isoDate);
  }

  let actualIso = await readDateFieldIso(dlg, labelText);
  if (actualIso === isoDate) {
    console.log(`📌 ${labelText} set to ${actualIso}`);
    return;
  }

  if (directSet) {
    await pickDate(page, dlg, labelText, isoDate).catch(() => {});
  } else {
    await trySetDateFieldDirectly(dlg, labelText, isoDate).catch(() => false);
  }

  actualIso = await readDateFieldIso(dlg, labelText);
  if (actualIso !== isoDate) {
    throw new Error(`Failed to verify ${labelText}. Expected ${isoDate}, got "${actualIso || 'unreadable'}"`);
  }

  console.log(`📌 ${labelText} set to ${actualIso}`);
}

/* =======================
   RETRY / DOWNLOAD HELPERS
======================= */

function removeSkippedSession(skippedSessions, sessionUrl, reasons = []) {
  for (let i = skippedSessions.length - 1; i >= 0; i--) {
    const item = skippedSessions[i];
    const sameSession = item.sessionUrl === sessionUrl;
    const sameReason = reasons.length === 0 || reasons.includes(item.reason);

    if (sameSession && sameReason) {
      skippedSessions.splice(i, 1);
    }
  }
}

function dedupeSkippedSessions(skippedSessions) {
  return skippedSessions.filter((item, index, arr) => {
    const firstIndex = arr.findIndex(x =>
      x.sessionUrl === item.sessionUrl &&
      x.reason === item.reason
    );
    return firstIndex === index;
  });
}

async function downloadAttendanceCsvForSession({
  context,
  sessionMeta,
  consoleScript,
  rosterText,
  missingNames
}) {
  const {
    onlyDate,
    group,
    sessionTopic,
    absUrl
  } = sessionMeta;

  const fileBase = `${safe(onlyDate)}_${safe(sessionTopic)}_${safe(group)}`.replace(/_+/g, '_');
  const expectedPath = getExpectedCsvPath(group, fileBase);

  if (fs.existsSync(expectedPath)) {
    console.log(`✅ Already exists, skip retry: ${expectedPath}`);
    return { ok: true, skippedBecauseExists: true, outPath: expectedPath };
  }

  const detailPage = await context.newPage();
  detailPage.on('console', async (msg) => {
    const text = msg.text();
    const isMissingNamesLog = text.includes('Names not found in ROSTER');
    const isAmbiguousNamesLog = text.includes('Ambiguous names were not exported');
    if (missingNames && (isMissingNamesLog || isAmbiguousNamesLog)) {
      try {
        const args = msg.args ? msg.args() : [];
        const raw = [];

        for (const arg of args) {
          raw.push(await arg.jsonValue().catch(() => null));
        }

        const extracted = [];
        for (const value of raw) {
          if (Array.isArray(value)) {
            for (const item of value) {
              const name = typeof item === 'string'
                ? item
                : item?.attendanceName || item?.name || '';
              if (String(name || '').trim()) extracted.push(String(name).trim());
            }
          }
        }

        if (!extracted.length && isMissingNamesLog) {
          const match = text.match(
            /Names not found in ROSTER(?:\s*\(\d+\))?:\s*\[([\s\S]*)\]\s*$/
          );
          if (match && match[1]) {
            extracted.push(
              ...match[1]
                .split(',')
                .map((n) => n.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean)
            );
          }
        }

        for (const name of extracted) {
          missingNames.push({
            name,
            email: findRosterEmailForName(name, rosterText),
            group,
          });
        }
      } catch (e) {}
    }
    console.log('🧩[DETAIL]', msg.type(), msg.text());
  });
  detailPage.on('pageerror', (err) => console.log('💥[DETAIL ERROR]', err.message));

  try {
    await detailPage.goto(absUrl, { waitUntil: 'networkidle' });
    await detailPage.waitForTimeout(WAIT_BETWEEN_SESSIONS_MS);

    const att = await getAttendanceState(detailPage);
    if (
      att.includes('not taken') ||
      att.includes('not-taken') ||
      (att.includes('not') && att.includes('taken'))
    ) {
      console.log('⏭️ Attendance not taken');
      await detailPage.close().catch(() => {});
      return { ok: false, reason: 'Attendance not taken' };
    }

    await detailPage.click(L.viewDetails);
    await detailPage.waitForSelector(L.attendanceDialog, { timeout: 25000 });
    await detailPage.waitForTimeout(600);

    let download = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🧪 RUN (attempt ${attempt}) -> ${fileBase}.csv`);

        [download] = await Promise.all([
          detailPage.waitForEvent('download', { timeout: DOWNLOAD_EVENT_TIMEOUT_MS }),
          detailPage.evaluate(consoleScript, { rosterText, fileBase }),
        ]);

        if (download) break;
      } catch (e) {
        console.log(`⚠️ Download failed attempt ${attempt}:`, e?.message || e);
        if (attempt < 3) {
          await detailPage.waitForTimeout(2000);
        }
      }
    }

    if (!download) {
      await detailPage.close().catch(() => {});
      return { ok: false, reason: 'CSV download failed / timed out' };
    }

    await download.saveAs(expectedPath);
    console.log(`✅ Saved ${expectedPath}`);

    await detailPage.waitForTimeout(WAIT_AFTER_CSV_DOWNLOAD_MS);
    await detailPage.close().catch(() => {});

    return { ok: true, outPath: expectedPath };
  } catch (e) {
    await detailPage.close().catch(() => {});
    return { ok: false, reason: `Failed to open session details: ${e?.message || e}` };
  }
}

/* =======================
   MAIN
======================= */

(async () => {
  console.log('🚀 Script started');
  console.log(`📅 Date Range: FROM ${DATE_FROM} TO ${DATE_TO}`);

  assertIsoDate(DATE_FROM);
  assertIsoDate(DATE_TO);
  console.log(`Round filter: ${ROUND_FILTER || 'none'}`);
  console.log(`Owner batch: ${BATCH_FILTER || 'all groups'}`);
  console.log(`Track: ${trackLabel(TRACK_FILTER)}`);
  if (compareIso(DATE_TO, DATE_FROM) < 0) {
    throw new Error(`DATE_TO (${DATE_TO}) must be >= DATE_FROM (${DATE_FROM})`);
  }

  const groupsWorkbookPath = resolveGroupsWorkbookPath(__dirname);
  console.log(`Groups workbook: ${groupsWorkbookPath}`);
  const wb = XLSX.readFile(groupsWorkbookPath);
  const groups = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  if (BATCH_FILTER && !GROUP_BATCHES[BATCH_FILTER]) {
    throw new Error(`Unknown owner batch: ${BATCH_FILTER}`);
  }
  if (BATCH_GROUPS.size) {
    const workbookGroups = new Set(groups.map((g) => String(g.group || '').trim()));
    const missingBatchGroups = [...BATCH_GROUPS].filter((group) => !workbookGroups.has(group));
    console.log(`Owner batch groups: ${BATCH_GROUPS.size}`);
    if (missingBatchGroups.length) {
      console.log(
        `[WARN] ${missingBatchGroups.length} batch groups are missing from ${path.basename(groupsWorkbookPath)} and cannot be exported until their rosters are added.`
      );
    }
  }
  if (GROUP_FILTER && !groups.some((g) => normalize(g.group) === normalize(GROUP_FILTER))) {
    console.log(`Warning: group "${GROUP_FILTER}" not found in ${path.basename(groupsWorkbookPath)}; dashboard filter will still be attempted.`);
  }
  console.log('📄 Groups loaded:', groups.map(g => g.group));

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let sessionsApiUrl = '';
  let sessionsApiHeaders = null;

  page.on('console', (msg) => {
    console.log('🌐[PAGE]', msg.type(), msg.text());
  });
  page.on('pageerror', (err) => console.log('💥[PAGE ERROR]', err.message));
  page.on('response', (response) => {
    if (/\/api\/v1\/admin\/sessions\//.test(response.url())) {
      sessionsApiUrl = response.url();
      sessionsApiHeaders = response.request().headers();
    }
  });

  const skippedSessions = [];
  const finishedSessions = [];
  const missingNames = []; // جمع الأسماء الناقصة

  const addSkip = ({ date, group, topic, status, reason, pageNum, sessionUrl }) => {
    skippedSessions.push({
      date: date || '',
      group: group || '',
      topic: topic || '',
      status: status || '',
      reason: reason || '',
      page: pageNum ?? '',
      sessionUrl: sessionUrl || '',
      time: nowISO(),
    });
  };

  await page.goto(LOGIN_URL);
  await page.fill(L.email, EMAIL);
  await page.fill(L.password, PASSWORD);
  await page.click(L.loginBtn);
  await page.waitForLoadState('networkidle');
  console.log('✅ Logged in');

  await page.goto(SESSIONS_URL);
  await page.waitForLoadState('networkidle');

  let dlg = await openFilterDialog(page);

  await pickDate(page, dlg, "Date From", DATE_FROM);

  if (!(await dlg.isVisible().catch(() => false))) {
    dlg = await openFilterDialog(page);
    await pickDate(page, dlg, "Date From", DATE_FROM);
  }

  await pickDate(page, dlg, "Date To", DATE_TO);

  if (ROUND_FILTER) {
    await applyRoundFilter(page, dlg, ROUND_FILTER);
  }

  if (GROUP_FILTER) {
    await applyGroupFilter(page, dlg, GROUP_FILTER);
  }

  await Promise.all([
    page.waitForLoadState('networkidle'),
    dlg.getByRole("button", { name: /Apply Filter/i }).click(),
  ]);

  await page.waitForTimeout(800);

  // Applying filters can preserve/insert page=1. The dashboard pagination is
  // zero-based, so always restart discovery from the canonical first page.
  // Otherwise the first 20 filtered rows are silently skipped.
  const firstFilteredPageUrl = setPageNumberInUrl(page.url(), 0);
  if (page.url() !== firstFilteredPageUrl) {
    await page.goto(firstFilteredPageUrl, { waitUntil: 'domcontentloaded' });
    await waitForSessionRowsReady(page);
    await page.waitForTimeout(WAIT_AFTER_NEXT_PAGE_MS);
  }

  const afterCount = await page.locator(L.rows).count();
  console.log("✅ Filter applied");
  console.log("🧾 Rows after filter =", afterCount);
  console.log("🔗 URL now =", page.url());

  if (afterCount === 0) {
    console.log("⚠️ No sessions returned for this date range.");
    const excelPath = writeSkippedExcel(skippedSessions, EXPORT_DIR, DATE_FROM, DATE_TO);
    if (excelPath) console.log("📌 Skipped Excel:", excelPath);
    await browser.close();
    console.log('🎉 Done');
    return;
  }

  await page.locator(L.rows).first().waitFor({ state: 'visible', timeout: 20000 });

  const consoleScript = buildConsoleScript();

  let skippedNoRoster = 0;
  let skippedByTrack = 0;
  let processed = 0;
  let downloaded = 0;

  let safetyPages = 0;
  const hardCapPages = 5000;

  let reliableApiSessions = null;
  try {
    reliableApiSessions = await discoverSessionsReliablyViaApi({
      page,
      apiUrl: sessionsApiUrl,
      apiHeaders: sessionsApiHeaders,
      groups,
      addSkip,
    });
  } catch (error) {
    console.log(`⚠️ Reliable API discovery failed; falling back to table pagination: ${error.message}`);
  }

  if (reliableApiSessions) {
    finishedSessions.push(...reliableApiSessions);
  } else while (true) {
    safetyPages++;
    await waitForSessionRowsReady(page);
    const curPage = getPageNumberFromUrl(page.url());
    console.log(`📄 Processing dashboard page = ${curPage + 1} (page=${curPage})`);

    const count = await page.locator(L.rows).count();
    console.log(`📌 Rows on this page: ${count}`);

    if (count === 0) {
      console.log("🛑 No rows on this page -> stop.");
      break;
    }

    const tableColumns = await getSessionTableColumns(page);

    for (let i = 0; i < count; i++) {
      const row = page.locator(L.rows).nth(i);

      const sessionNameRaw = await readTableCell(row, tableColumns.name);
      const modeRaw        = await readTableCell(row, tableColumns.type);
      const sessionDateRaw = await readTableCell(row, tableColumns.date);
      const group          = await readTableCell(row, tableColumns.group);
      const sessionTopic   = await readTableCell(row, tableColumns.topic);
      const statusText     = await readTableCell(row, tableColumns.status);

      const m = (sessionDateRaw || '').match(/\d{4}-\d{2}-\d{2}/);
      const onlyDate = m ? m[0] : (sessionDateRaw || '').split('\n')[0].trim();

      const pageNum = curPage;

      const sessionUrl = await row.locator(L.sessionLink).getAttribute('href').catch(() => null);
      const absUrl = sessionUrl?.startsWith('http')
        ? sessionUrl
        : (sessionUrl ? new URL(sessionUrl, page.url()).toString() : '');

      // Groups outside the selected track are ignored completely: no work,
      // no log line, and no row in the skipped report.
      if (group && !matchesTrack(group, TRACK_FILTER)) {
        skippedByTrack++;
        continue;
      }

      console.log('📅', onlyDate, '| 🧠', sessionTopic, '| 👥', group, '| ✅', statusText);

      if (!onlyDate || !group) {
        addSkip({
          date: onlyDate,
          group,
          topic: sessionTopic,
          status: statusText,
          reason: 'Missing essential fields (date/group)',
          pageNum,
          sessionUrl: absUrl
        });
        continue;
      }

      const groupRound = group.match(/^[A-Za-z]{3,4}([45])/)?.[1] || '';
      if (ROUND_FILTER && groupRound !== ROUND_FILTER) {
        addSkip({
          date: onlyDate,
          group,
          topic: sessionTopic,
          status: statusText,
          reason: groupRound
            ? `Skipped by round filter (Round ${groupRound}; selected Round ${ROUND_FILTER})`
            : `Skipped by round filter (unrecognized group name; selected Round ${ROUND_FILTER})`,
          pageNum,
          sessionUrl: absUrl
        });
        console.log(`Skipped ${group} — selected Round ${ROUND_FILTER}`);
        continue;
      }

      if (BATCH_GROUPS.size && !BATCH_GROUPS.has(group)) {
        continue;
      }

      const groupRow = groups.find(g => normalize(g.group) === normalize(group));
      if (!groupRow || !groupRow.roster) {
        skippedNoRoster++;
        addSkip({
          date: onlyDate,
          group,
          topic: sessionTopic,
          status: statusText,
          reason: 'No roster for group',
          pageNum,
          sessionUrl: absUrl
        });
        console.log(`⏭️ Skipped — no roster for ${group}`);
        continue;
      }

      if (normalize(statusText) !== 'finished') {
        addSkip({
          date: onlyDate,
          group,
          topic: sessionTopic,
          status: statusText,
          reason: 'Session not finished',
          pageNum,
          sessionUrl: absUrl
        });
        console.log(`⏭️ Skipped — status = ${statusText}`);
        continue;
      }

      const finishedTitle = formatFinishedTitle({
        sessionNameRaw,
        sessionDateRaw,
        modeRaw,
        typeRaw: sessionTopic
      });

      if (finishedTitle) {
        await appendFinishedTitleToGroup(group, absUrl, finishedTitle);
      }

      if (!absUrl) {
        addSkip({
          date: onlyDate,
          group,
          topic: sessionTopic,
          status: statusText,
          reason: 'Missing session URL',
          pageNum,
          sessionUrl: ''
        });
        continue;
      }

      const fileBase = `${safe(onlyDate)}_${safe(sessionTopic)}_${safe(group)}`.replace(/_+/g, '_');

      const sessionMeta = {
        onlyDate,
        group,
        sessionTopic,
        statusText,
        absUrl,
        pageNum,
        fileBase
      };

      finishedSessions.push(sessionMeta);
    }

    if (safetyPages >= hardCapPages) {
      console.log("🛑 hardCapPages reached, stopping.");
      break;
    }

    let moved = await gotoNextPageByUrl(page);
    if (!moved) {
      moved = await gotoNextPage(page);
      if (moved) {
        console.log("🔁 Extra page found in final pagination check, continuing.");
      } else {
        console.log("🛑 No further pages (URL increment did not change content).");
        break;
      }
    }
  }

  console.log(`🔎 Discovery complete: ${finishedSessions.length} finished session rows found.`);
  console.log('🎯 Starting download phase for missing CSVs only...');

  // A group can expose several different sessions through the same attendance
  // URL.  The output filename includes the group/date/session identity, so it is
  // the reliable dedupe key.  Using absUrl here silently collapsed multiple
  // sessions from the same group into one item.
  const uniqueFinishedSessions = [...new Map(
    finishedSessions.map((session) => [session.fileBase, session])
  ).values()];

  const missingSessions = uniqueFinishedSessions.filter((s) => {
    const expectedPath = getExpectedCsvPath(s.group, s.fileBase);
    return !fs.existsSync(expectedPath);
  });

  console.log(`📌 Unique finished sessions = ${uniqueFinishedSessions.length}`);
  console.log(`✅ Existing CSV checkpoints = ${uniqueFinishedSessions.length - missingSessions.length}`);
  console.log(`📌 Missing CSVs to download = ${missingSessions.length}`);

  for (const sessionMeta of missingSessions) {
    const groupRow = groups.find(g => normalize(g.group) === normalize(sessionMeta.group));

    if (!groupRow || !groupRow.roster) {
      console.log(`⏭️ Retry skipped — no roster for ${sessionMeta.group}`);
      continue;
    }

    let result = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(
        `🎯 Session attempt ${attempt}/3: ${sessionMeta.group} | ` +
        `${sessionMeta.onlyDate} | ${sessionMeta.sessionTopic}`
      );
      result = await downloadAttendanceCsvForSession({
        context,
        sessionMeta,
        consoleScript,
        rosterText: groupRow.roster,
        missingNames
      });
      if (result.ok || result.reason === 'Attendance not taken') break;
      if (attempt < 3) await page.waitForTimeout(1200 * attempt);
    }

    if (result.ok) {
      console.log(`✅ Retry success: ${sessionMeta.fileBase}.csv`);

      removeSkippedSession(skippedSessions, sessionMeta.absUrl, [
        'CSV download failed / timed out'
      ]);

      const failedOpenReasonPrefix = 'Failed to open session details';
      for (let i = skippedSessions.length - 1; i >= 0; i--) {
        if (
          skippedSessions[i].sessionUrl === sessionMeta.absUrl &&
          String(skippedSessions[i].reason || '').startsWith(failedOpenReasonPrefix)
        ) {
          skippedSessions.splice(i, 1);
        }
      }

      downloaded++;
      processed++;
    } else {
      console.log(`❌ Retry still failed: ${sessionMeta.fileBase}.csv -> ${result.reason}`);

      const alreadyExists = skippedSessions.some(
        x => x.sessionUrl === sessionMeta.absUrl && x.reason === result.reason
      );

      if (!alreadyExists) {
        addSkip({
          date: sessionMeta.onlyDate,
          group: sessionMeta.group,
          topic: sessionMeta.sessionTopic,
          status: sessionMeta.statusText,
          reason: result.reason,
          pageNum: sessionMeta.pageNum,
          sessionUrl: sessionMeta.absUrl
        });
      }
    }

    await page.waitForTimeout(WAIT_BETWEEN_SESSIONS_MS);
  }

  const stillMissingSessions = uniqueFinishedSessions.filter((session) =>
    !fs.existsSync(getExpectedCsvPath(session.group, session.fileBase))
  );
  const checkpointPath = path.join(EXPORT_DIR, 'attendance_checkpoint.json');
  const checkpoint = {
    updatedAt: new Date().toISOString(),
    filters: {
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      round: ROUND_FILTER,
      owner: BATCH_FILTER,
      track: TRACK_FILTER,
      group: GROUP_FILTER,
    },
    discoveredCount: uniqueFinishedSessions.length,
    completedCount: uniqueFinishedSessions.length - stillMissingSessions.length,
    pendingCount: stillMissingSessions.length,
    pendingSessions: stillMissingSessions,
  };
  await writeFileWithRetry(checkpointPath, JSON.stringify(checkpoint, null, 2));

  if (stillMissingSessions.length) {
    console.log(`❌ FINAL VERIFICATION FAILED: ${stillMissingSessions.length} sessions still have no CSV.`);
    console.log(`📌 Retry checkpoint saved: ${checkpointPath}`);
  } else {
    console.log(
      `✅ FINAL VERIFICATION PASSED: all ${uniqueFinishedSessions.length} discovered sessions have CSV files.`
    );
  }

  const finalSkippedSessions = dedupeSkippedSessions(skippedSessions);

  console.log("📊 SUMMARY:");
  console.log("✅ processed =", processed);
  console.log("⏭️ skippedNoRoster =", skippedNoRoster);
  if (TRACK_FILTER !== TRACK_ALL) {
    console.log(`⏭️ ignored (outside ${trackLabel(TRACK_FILTER)} track) =`, skippedByTrack);
  }
  console.log("⬇️ downloaded =", downloaded);
  console.log("🧾 skipped total =", finalSkippedSessions.length);

  if (finalSkippedSessions.length) {
    const counts = {};
    for (const s of finalSkippedSessions) {
      const r = s.reason || 'UNKNOWN';
      counts[r] = (counts[r] || 0) + 1;
    }
    console.log("🧯 Skipped/Error reasons breakdown:");
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([reason, n]) => console.log(`- ${reason}: ${n}`));
  } else {
    console.log("✅ No skipped/errors.");
  }

  const excelPath = writeSkippedExcel(finalSkippedSessions, EXPORT_DIR, DATE_FROM, DATE_TO);
  if (excelPath) {
    console.log("📌 Skipped sessions Excel saved:", excelPath);
  } else {
    console.log("📌 No skipped sessions -> Excel not created.");
  }

  // حفظ الأسماء الناقصة في CSV تراكمي
  if (missingNames.length > 0) {
    const missingCsvPath = await writeLmsMissingNamesCsv(missingNames, EXPORT_DIR);
    if (missingCsvPath) {
      const uniqueNamesCount = new Set(
        missingNames.map((m) => `${normalize(m.name)}||${normalize(m.group)}`)
      ).size;
      console.log(`📋 LMS missing names CSV saved: ${missingCsvPath} (${uniqueNamesCount} unique entries, ${missingNames.length} total)`);
    }
  } else {
    console.log("✅ No missing names found!");
  }

  // تشخيص: طباعة كل التواريخ اللي اتعالجت فعلاً
  const datesProcessed = new Set(finishedSessions.map(s => s.onlyDate).filter(Boolean));
  const sortedDates = [...datesProcessed].sort();
  console.log(`📆 Unique session dates seen during run (${sortedDates.length}): ${sortedDates.join(', ')}`);
  if (sortedDates.length) {
    console.log(`📆 Earliest = ${sortedDates[0]}, Latest = ${sortedDates[sortedDates.length - 1]} (filter was ${DATE_FROM} → ${DATE_TO})`);
    if (compareIso(sortedDates[sortedDates.length - 1], DATE_TO) < 0) {
      console.log(`⚠️ Latest session date seen (${sortedDates[sortedDates.length - 1]}) is earlier than requested DATE_TO (${DATE_TO}). This usually means the dashboard returned an incomplete filtered range.`);
    }
  }

  await browser.close();
  console.log('🎉 Done');
})();
