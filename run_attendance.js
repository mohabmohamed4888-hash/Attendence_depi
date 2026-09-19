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
const {
  MISSING_NAMES_FILE,
  normalize,
  parseCsvRows,
  parseRosterEmails,
  syncMissingStudents,
} = require('./group_roster_sync');

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
const API_BASE = 'https://back.depi.eyouthbusiness.com/api/v1';

const EXPORT_DIR = './exports';
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

const BATCH_GROUPS = new Set(GROUP_BATCHES[BATCH_FILTER] || []);

/* =======================
   API SETTINGS
======================= */

// The sessions API orders rows non-deterministically when several sessions share
// the same date/time, so walking its small pages returns duplicates and silently
// misses other sessions. Asking for one large page per day avoids that entirely.
const API_PAGE_SIZE = 500;
const API_RETRIES = 4;
const ATTENDANCE_CONCURRENCY = 5;

/* =======================
   HELPERS
======================= */

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

function eachIsoDate(fromIso, toIso) {
  const days = [];
  const cur = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
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
        // Not SheetJS: it guesses "|" as the separator of these files (the
        // titles are full of pipes) and then no existing row is recognised,
        // so every run appended the same sessions again.
        const rows = parseCsvRows(fs.readFileSync(filePath, 'utf-8'));

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
   CSVs that changed after they were uploaded
   exports/pending_reuploads.json lists attendance CSVs that were rewritten
   with different content (attendance changed on the dashboard, or students
   were added to the roster). lms-bot/upload.py re-uploads those sessions even
   when the LMS already has attendance for them, then drops them from the list.
======================= */

const PENDING_REUPLOADS_FILE = path.join(EXPORT_DIR, 'pending_reuploads.json');

function readPendingReuploads() {
  if (!fs.existsSync(PENDING_REUPLOADS_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_REUPLOADS_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (error) {
    console.log(`⚠️ Could not read ${PENDING_REUPLOADS_FILE}: ${error.message}`);
  }
  return {};
}

// Same key upload.py builds: the CSV path relative to exports/, with slashes.
function pendingReuploadKey(csvPath) {
  return path.relative(EXPORT_DIR, csvPath).split(path.sep).join('/');
}

/* =======================
   DASHBOARD API
======================= */

async function loginAndCaptureApiHeaders(page) {
  if (!EMAIL || !PASSWORD) {
    throw new Error('LOGIN_EMAIL / LOGIN_PASSWORD are missing from .env');
  }

  let apiHeaders = null;
  page.on('request', (request) => {
    if (apiHeaders || !request.url().startsWith(API_BASE)) return;
    const headers = request.headers();
    if (headers.authorization) apiHeaders = headers;
  });

  await page.goto(LOGIN_URL);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('button:has-text("Login")');
  await page.waitForLoadState('networkidle');

  if (page.url().includes('/auth/login')) {
    throw new Error('Login failed. Check LOGIN_EMAIL / LOGIN_PASSWORD in .env');
  }
  console.log('✅ Logged in');

  // Opening the sessions page makes the dashboard call its API with the
  // logged-in token; every later request reuses those headers. The page is
  // opened already filtered to the selected dates so the browser window shows
  // the same sessions the script is exporting.
  const filteredUrl = `${SESSIONS_URL}?${new URLSearchParams({ date_from: DATE_FROM, date_to: DATE_TO })}`;
  await page.goto(filteredUrl);
  await page.waitForLoadState('networkidle');
  console.log(`🔎 Dashboard filtered: ${filteredUrl}`);
  for (let i = 0; i < 60 && !apiHeaders; i++) await sleep(500);

  if (!apiHeaders) {
    throw new Error('Could not capture the dashboard API token after login');
  }
  return apiHeaders;
}

function createApiClient(page, headers) {
  async function get(url) {
    const target = String(url).replace('http://', 'https://');
    let lastError = null;

    for (let attempt = 1; attempt <= API_RETRIES; attempt++) {
      try {
        const response = await page.request.get(target, { headers, timeout: 60000 });
        const status = response.status();
        if (response.ok()) return response.json();
        if (status === 401 || status === 403) {
          throw Object.assign(new Error(`API ${status} (not authorized) for ${target}`), { fatal: true });
        }
        lastError = new Error(`API ${status} for ${target}`);
        if (status < 500 && status !== 429) throw Object.assign(lastError, { fatal: true });
      } catch (error) {
        if (error.fatal) throw error;
        lastError = error;
      }
      if (attempt < API_RETRIES) await sleep(1500 * attempt);
    }

    throw lastError;
  }

  return { get };
}

async function listDaySessionsPaged(api, day) {
  const params = new URLSearchParams({
    date_from: day,
    date_to: day,
    page_size: String(API_PAGE_SIZE),
  });
  let next = `${API_BASE}/admin/sessions/?${params}`;
  const byId = new Map();
  let expected = null;

  while (next) {
    const payload = await api.get(next);
    if (expected == null) expected = Number(payload.pagination?.count ?? 0);
    for (const session of payload.data || []) {
      if (session?.id) byId.set(session.id, session);
    }
    next = payload.pagination?.next || null;
  }

  return { byId, expected: expected ?? 0 };
}

let dropdownGroupsCache = null;

async function getAllDashboardGroups(api) {
  if (!dropdownGroupsCache) {
    const payload = await api.get(`${API_BASE}/groups/dropdown/`);
    const groups = Array.isArray(payload) ? payload : (payload.data || []);
    dropdownGroupsCache = groups
      .map((group) => ({ id: group.value || group.id, name: group.label || group.name }))
      .filter((group) => group.id);
  }
  return dropdownGroupsCache;
}

async function listDaySessions(api, day) {
  const { byId, expected } = await listDaySessionsPaged(api, day);
  if (byId.size >= expected) return { sessions: [...byId.values()], expected };

  // A single day should always fit in one page. If the API ever caps the page
  // size, fall back to one query per group so no session can slip between pages.
  console.log(
    `[WARN] ${day}: API listed ${byId.size} of ${expected} sessions; ` +
    `re-checking group by group...`
  );
  const groups = await getAllDashboardGroups(api);
  for (let i = 0; i < groups.length; i += 10) {
    const chunk = groups.slice(i, i + 10);
    const results = await Promise.all(chunk.map(async (group) => {
      const params = new URLSearchParams({
        date_from: day,
        date_to: day,
        group: group.id,
        page_size: String(API_PAGE_SIZE),
      });
      const payload = await api.get(`${API_BASE}/admin/sessions/?${params}`);
      return payload.data || [];
    }));
    for (const session of results.flat()) {
      if (session?.id) byId.set(session.id, session);
    }
  }

  return { sessions: [...byId.values()], expected };
}

async function listAllSessions(api, fromIso, toIso) {
  const all = new Map();
  const incompleteDays = [];

  for (const day of eachIsoDate(fromIso, toIso)) {
    const { sessions, expected } = await listDaySessions(api, day);
    for (const session of sessions) all.set(session.id, session);
    console.log(`📅 ${day}: ${sessions.length} sessions (dashboard total ${expected})`);
    if (sessions.length < expected) incompleteDays.push(`${day} (${sessions.length}/${expected})`);
  }

  if (incompleteDays.length) {
    throw new Error(
      `The dashboard API did not return every session for: ${incompleteDays.join(', ')}. ` +
      `Stopping instead of exporting an incomplete list.`
    );
  }

  return [...all.values()];
}

function attendanceEndpoints(session) {
  const live = `${API_BASE}/attendance/live-records/${session.id}/`;
  const physical = `${API_BASE}/physical-attendance/${session.id}/records/`;
  return normalize(session.delivery_mode) === 'physical' ? [physical, live] : [live, physical];
}

async function fetchAttendanceRecords(api, session) {
  // Online and physical sessions keep attendance in different endpoints; try the
  // one that matches the delivery mode first and the other one as a safety net.
  for (const url of attendanceEndpoints(session)) {
    const payload = await api.get(url).catch((error) => {
      if (error.fatal && /API 404/.test(error.message)) return null;
      throw error;
    });
    const records = payload?.data?.records;
    if (Array.isArray(records) && records.length) return records;
  }
  return [];
}

/* =======================
   ATTENDANCE CSV
======================= */

// Same file the old in-page console script downloaded: UTF-8 BOM, header
// "user_identifier,status", CRLF, one row per roster student sorted by email,
// P = Joined and A = Not-Joined. Students who are not in the group roster are
// left out of the CSV; the roster sync looks them up on the dashboard and adds
// them to groups.xlsx (see group_roster_sync.js), and only the ones it cannot
// match end up in "Lms missing names.csv".
function buildAttendanceCsv(records, rosterEmails) {
  const statusByEmail = new Map();
  const notInRoster = [];

  for (const record of records) {
    const email = String(record.student?.user?.email || '').trim().toLowerCase();
    const name = String(record.student?.full_name || '').trim() || email;

    if (!email || !rosterEmails.has(email)) {
      notInRoster.push({ name, email });
      continue;
    }

    const status = record.joined ? 'P' : 'A';
    if (statusByEmail.get(email) !== 'P') statusByEmail.set(email, status);
  }

  const rows = [...statusByEmail.entries()]
    .map(([email, status]) => ({ user_identifier: email, status }))
    .sort((a, b) => a.user_identifier.localeCompare(b.user_identifier));

  const content = '\ufeff' + [
    ['user_identifier', 'status'],
    ...rows.map((row) => [row.user_identifier, row.status]),
  ].map((columns) => columns.map(csvEscape).join(',')).join('\r\n');

  return { content, rowCount: rows.length, notInRoster };
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* =======================
   MAIN
======================= */

(async () => {
  let browser = null;

  try {
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
      console.log(`Warning: group "${GROUP_FILTER}" not found in ${path.basename(groupsWorkbookPath)}.`);
    }
    console.log('📄 Groups loaded:', groups.map(g => g.group));

    const rosterByGroup = new Map(groups.map((row) => [normalize(row.group), row]));

    browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log('💥[PAGE ERROR]', err.message));

    const apiHeaders = await loginAndCaptureApiHeaders(page);
    const api = createApiClient(page, apiHeaders);

    /* ---------- 1) Discover every session in the date range ---------- */

    console.log('⚡ Listing sessions from the dashboard API, one day at a time...');
    const allSessions = await listAllSessions(api, DATE_FROM, DATE_TO);
    console.log(`✅ Dashboard has ${allSessions.length} sessions in ${DATE_FROM} → ${DATE_TO}`);

    const skippedSessions = [];
    const missingNames = [];

    const addSkip = ({ date, group, topic, status, reason, sessionUrl }) => {
      skippedSessions.push({
        date: date || '',
        group: group || '',
        topic: topic || '',
        status: status || '',
        reason: reason || '',
        page: 'API',
        sessionUrl: sessionUrl || '',
        time: nowISO(),
      });
    };

    let skippedByTrack = 0;
    let skippedByFilter = 0;
    let skippedNoRoster = 0;
    const workItems = [];

    for (const session of allSessions) {
      const group = String(session.group?.label || '').trim();
      const focus = String(session.focus || '').trim().toLowerCase();
      const onlyDate = String(session.date || '').slice(0, 10);
      const absUrl = `${SESSIONS_URL}/${session.id}`;
      const sessionTopic = focus === 'soft_skill'
        ? 'Soft Skill'
        : (focus === 'technical' ? 'Technical' : String(session.focus || 'Session'));
      const skipBase = { date: onlyDate, group, topic: sessionTopic, status: session.status_by_trainer, sessionUrl: absUrl };

      if (!group || !onlyDate) {
        addSkip({ ...skipBase, reason: 'Missing essential fields (date/group)' });
        continue;
      }

      // Groups outside the selected track are ignored completely: no work,
      // no log line, and no row in the skipped report.
      if (!matchesTrack(group, TRACK_FILTER)) {
        skippedByTrack++;
        continue;
      }
      if (TRACK_FILTER === TRACK_NON_TECHNICAL && focus !== 'soft_skill') {
        skippedByTrack++;
        continue;
      }
      if (TRACK_FILTER === TRACK_TECHNICAL && focus !== 'technical') {
        skippedByTrack++;
        continue;
      }

      const groupRound = group.match(/^[A-Za-z]{3,4}([45])/)?.[1] || '';
      if (
        (GROUP_FILTER && normalize(group) !== normalize(GROUP_FILTER)) ||
        (BATCH_GROUPS.size && !BATCH_GROUPS.has(group)) ||
        (ROUND_FILTER && groupRound !== ROUND_FILTER)
      ) {
        skippedByFilter++;
        continue;
      }

      if (!session.is_finished || normalize(session.status_by_trainer) !== 'finished') {
        addSkip({ ...skipBase, reason: 'Session not finished' });
        continue;
      }

      const groupRow = rosterByGroup.get(normalize(group));
      if (!groupRow || !groupRow.roster) {
        skippedNoRoster++;
        addSkip({ ...skipBase, reason: 'No roster for group' });
        console.log(`⏭️ Skipped — no roster for ${group}`);
        continue;
      }

      // Keep the actual scheduled start time from the API. Passing `onlyDate`
      // here drops the time and previously forced every title to 00:00 -> 03:00.
      const finishedTitle = formatFinishedTitle({
        sessionNameRaw: session.name || '',
        sessionDateRaw: getApiSessionDateTimeRaw(session),
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

      workItems.push({
        session,
        group,
        onlyDate,
        sessionTopic,
        statusText: 'Finished',
        absUrl,
        sessionId: session.id,
        roster: groupRow.roster,
        fileBase: `${safe(onlyDate)}_${safe(sessionTopic)}_${safe(group)}`.replace(/_+/g, '_'),
      });
    }

    // Two different sessions of one group on the same day with the same type
    // would otherwise write the same CSV and one of them would be lost.
    const byFileBase = new Map();
    for (const item of workItems) {
      byFileBase.set(item.fileBase, [...(byFileBase.get(item.fileBase) || []), item]);
    }
    for (const [fileBase, items] of byFileBase) {
      if (items.length < 2) continue;
      items.sort((a, b) => String(a.session.time).localeCompare(String(b.session.time)));
      items.slice(1).forEach((item) => {
        item.fileBase = `${fileBase}_${String(item.session.time || '').slice(0, 5).replace(':', '')}`;
      });
      console.log(
        `[WARN] ${items.length} sessions share ${fileBase}.csv; extra ones saved as ` +
        `${items.slice(1).map((item) => `${item.fileBase}.csv`).join(', ')}. Check their LMS upload manually.`
      );
    }

    console.log(`🔎 Sessions to export after filters: ${workItems.length}`);

    /* ---------- 2) Download attendance for each session ---------- */

    await runWithConcurrency(workItems, ATTENDANCE_CONCURRENCY, async (item) => {
      const { session, group, onlyDate, sessionTopic, absUrl } = item;
      const skipBase = { date: onlyDate, group, topic: sessionTopic, status: item.statusText, sessionUrl: absUrl };

      if (!session.is_attendance_taken) {
        console.log(`⏭️ Attendance not taken: ${group} | ${onlyDate} | ${sessionTopic}`);
        addSkip({ ...skipBase, reason: 'Attendance not taken' });
        return;
      }

      let records;
      try {
        records = await fetchAttendanceRecords(api, session);
      } catch (error) {
        console.log(`❌ Could not load attendance: ${group} | ${onlyDate} -> ${error.message}`);
        addSkip({ ...skipBase, reason: `Failed to load attendance: ${error.message}` });
        return;
      }

      if (!records.length) {
        console.log(`❌ No attendance records on the dashboard: ${group} | ${onlyDate} | ${sessionTopic}`);
        addSkip({ ...skipBase, reason: 'No attendance records returned by dashboard' });
        return;
      }

      // The CSV itself is written in step 4, once the rosters had the chance
      // to grow; here we only note who is missing from the roster right now.
      item.records = records;
      const { notInRoster } = buildAttendanceCsv(records, parseRosterEmails(item.roster));
      for (const student of notInRoster) missingNames.push({ ...student, group });
      if (notInRoster.length) {
        console.log(`⚠️ ${group} | ${onlyDate}: ${notInRoster.length} students are not in the roster; looking them up on the dashboard next`);
      }
    });

    /* ---------- 3) Add the missing students to groups.xlsx ---------- */

    // Every missing student (plus the ones still listed in the CSV from earlier
    // runs) is searched on the dashboard, exactly like the students page search,
    // and appended to the roster of the group the dashboard lists them in.
    // Students that cannot be matched stay in "Lms missing names.csv" with a reason.
    let rosterSync = { additions: [], unresolved: [], missingCsvPath: null };
    try {
      rosterSync = await syncMissingStudents({
        api,
        apiBase: API_BASE,
        workbookPath: groupsWorkbookPath,
        rosterByGroup,
        candidates: missingNames,
        exportDir: EXPORT_DIR,
      });
    } catch (error) {
      console.log(`❌ Roster sync failed; the CSVs use the rosters as they are: ${String(error.message).split('\n')[0]}`);
    }

    /* ---------- 4) Write one attendance CSV per session ---------- */

    let written = 0;
    let updated = 0;
    let unchanged = 0;
    const pendingReuploads = readPendingReuploads();
    let flaggedForReupload = 0;

    for (const item of workItems) {
      if (!item.records) continue;
      const { group, onlyDate, sessionTopic, absUrl, fileBase } = item;
      const skipBase = { date: onlyDate, group, topic: sessionTopic, status: item.statusText, sessionUrl: absUrl };

      // Read the roster again: step 3 may have just added students to it.
      const roster = rosterByGroup.get(normalize(group))?.roster;
      const { content, rowCount, notInRoster } = buildAttendanceCsv(item.records, parseRosterEmails(roster));
      if (notInRoster.length) {
        console.log(
          `⚠️ ${group} | ${onlyDate}: still not in the ${group} roster: ` +
          notInRoster.map((student) => student.name || student.email).join(', ')
        );
      }

      if (!rowCount) {
        addSkip({ ...skipBase, reason: 'No attendance students matched the roster' });
        continue;
      }

      const outPath = getExpectedCsvPath(group, fileBase);
      const previous = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8') : null;
      if (previous === content) {
        unchanged++;
        continue;
      }

      await writeFileWithRetry(outPath, content);
      if (previous == null) {
        written++;
        console.log(`✅ Saved ${outPath} (${rowCount} students)`);
      } else {
        updated++;
        // The LMS may already hold the old version of this session's attendance;
        // upload.py re-uploads it because of this entry.
        pendingReuploads[pendingReuploadKey(outPath)] = {
          group,
          date: onlyDate,
          sessionType: sessionTopic,
          updatedAt: new Date().toLocaleString('sv-SE'),
        };
        flaggedForReupload++;
        console.log(`♻️ Updated ${outPath} (${rowCount} students; attendance or roster changed) → flagged for LMS re-upload`);
      }
    }

    if (flaggedForReupload) {
      await writeFileWithRetry(PENDING_REUPLOADS_FILE, JSON.stringify(pendingReuploads, null, 2));
      console.log(
        `♻️ ${flaggedForReupload} updated CSV(s) flagged for re-upload in ${PENDING_REUPLOADS_FILE} ` +
        `(${Object.keys(pendingReuploads).length} waiting in total)`
      );
    }

    /* ---------- 5) Verify every session is accounted for ---------- */

    const finalSkippedSessions = skippedSessions.filter((item, index, arr) =>
      arr.findIndex((x) => x.sessionUrl === item.sessionUrl && x.reason === item.reason) === index
    );
    const stillMissingSessions = workItems
      .filter((item) => !fs.existsSync(getExpectedCsvPath(item.group, item.fileBase)))
      .map(({ session, roster, records, ...item }) => item);

    const accounted =
      skippedByTrack + skippedByFilter + finalSkippedSessions.length + written + updated + unchanged;

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
      dashboardSessions: allSessions.length,
      discoveredCount: workItems.length,
      completedCount: workItems.length - stillMissingSessions.length,
      pendingCount: stillMissingSessions.length,
      pendingSessions: stillMissingSessions,
    };
    await writeFileWithRetry(checkpointPath, JSON.stringify(checkpoint, null, 2));

    console.log('📊 SUMMARY:');
    console.log(`🗂️ dashboard sessions in range = ${allSessions.length}`);
    if (TRACK_FILTER !== TRACK_ALL) {
      console.log(`⏭️ ignored (outside ${trackLabel(TRACK_FILTER)} track) =`, skippedByTrack);
    }
    console.log('⏭️ outside group / owner / round filter =', skippedByFilter);
    console.log('⏭️ skippedNoRoster =', skippedNoRoster);
    console.log('⬇️ new CSVs =', written);
    console.log('♻️ updated CSVs =', updated);
    console.log('♻️ CSVs waiting for LMS re-upload =', Object.keys(pendingReuploads).length);
    console.log('✔️ already up to date =', unchanged);
    console.log('➕ students added to groups.xlsx =', rosterSync.additions.length);
    console.log('❓ students still missing from the rosters =', rosterSync.unresolved.length);
    console.log('🧾 skipped total =', finalSkippedSessions.length);

    if (finalSkippedSessions.length) {
      const counts = {};
      for (const s of finalSkippedSessions) {
        const r = s.reason || 'UNKNOWN';
        counts[r] = (counts[r] || 0) + 1;
      }
      console.log('🧯 Skipped/Error reasons breakdown:');
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([reason, n]) => console.log(`- ${reason}: ${n}`));
    } else {
      console.log('✅ No skipped/errors.');
    }

    if (accounted === allSessions.length) {
      console.log(
        `✅ FINAL VERIFICATION PASSED: all ${allSessions.length} dashboard sessions are accounted for ` +
        `(exported, filtered out, or listed in the skipped report).`
      );
    } else {
      console.log(
        `❌ FINAL VERIFICATION FAILED: ${allSessions.length} dashboard sessions but only ${accounted} accounted for.`
      );
    }

    const excelPath = writeSkippedExcel(finalSkippedSessions, EXPORT_DIR, DATE_FROM, DATE_TO);
    if (excelPath) {
      console.log('📌 Skipped sessions Excel saved:', excelPath);
    } else {
      console.log('📌 No skipped sessions -> Excel not created.');
    }

    if (rosterSync.missingCsvPath) {
      console.log(
        `📋 ${MISSING_NAMES_FILE} saved: ${rosterSync.missingCsvPath} ` +
        `(${rosterSync.unresolved.length} students to add by hand; see the reason column)`
      );
    } else {
      console.log('✅ No missing names left to add by hand.');
    }

    const sortedDates = [...new Set(workItems.map((s) => s.onlyDate).filter(Boolean))].sort();
    console.log(`📆 Unique session dates exported (${sortedDates.length}): ${sortedDates.join(', ')}`);

    console.log('🎉 Done');
  } catch (error) {
    console.log(`[ERROR] ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
