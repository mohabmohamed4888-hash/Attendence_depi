/* =======================
   DASHBOARD STUDENT STATUS
   The LMS refuses a student whose email is not enrolled in the Wavz course
   ("A user with the email set to X could not be found in this course") and
   upload.py lists them in "missing from wavz.csv". For a student who left the
   program that rejection is expected, not a problem to chase: the dashboard
   marks them "not_active".

   So the dashboard status of every student is kept in
   exports/student_status.json and the not-active ones are dropped from the
   missing-from-Wavz list:

     * run_attendance.js already downloads the attendance records, and every
       record carries its student's status, so the file is refreshed on every
       attendance run without a single extra request
     * upload.py reads that file and never lists a not-active student
     * an attendance run also cleans the list itself, looking up any email
       whose status is not in the file yet (one quick search per email)

   A student whose status cannot be established stays in the list: an unknown
   status must never hide a real enrolment problem.
======================= */

const fs = require('fs');
const path = require('path');

const STATUS_FILE = 'student_status.json';
const MISSING_FROM_WAVZ_FILE = 'missing from wavz.csv';
const LOOKUP_CONCURRENCY = 5;

const cleanEmail = (email) => String(email || '').trim().toLowerCase();

// "Not Active", "not_active" and "not-active" are the same thing.
const normalizeStatus = (status) =>
  String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const ACTIVE_STATUS = 'active';

function isNotActive(status) {
  const normalized = normalizeStatus(status);
  return Boolean(normalized) && normalized !== ACTIVE_STATUS;
}

function localDateTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/* =======================
   THE STATUS FILE
======================= */

function statusFilePath(exportDir) {
  return path.join(exportDir, STATUS_FILE);
}

function readStatusMap(exportDir, log = console.log) {
  const filePath = statusFilePath(exportDir);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const students = parsed?.students;
    if (students && typeof students === 'object' && !Array.isArray(students)) return students;
  } catch (error) {
    log(`⚠️ Could not read ${STATUS_FILE}: ${error.message}`);
  }
  return {};
}

function writeStatusMap(exportDir, students, log = console.log) {
  const filePath = statusFilePath(exportDir);
  const sorted = Object.fromEntries(
    Object.entries(students).sort(([a], [b]) => a.localeCompare(b))
  );
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ updatedAt: localDateTime(), students: sorted }, null, 2),
      'utf-8'
    );
    return filePath;
  } catch (error) {
    log(`⚠️ Could not save ${STATUS_FILE}: ${error.message}`);
    return null;
  }
}

// Attendance records already carry the whole student object, status included.
function recordStatusesFromAttendance(students, records, group) {
  let added = 0;
  const checkedAt = localDateTime();

  for (const record of records || []) {
    const student = record?.student;
    const email = cleanEmail(student?.user?.email);
    const status = normalizeStatus(student?.status);
    if (!email || !status) continue;

    const previous = students[email];
    if (!previous || previous.status !== status) added++;
    students[email] = {
      status,
      name: String(student?.full_name || previous?.name || '').trim(),
      group: String(student?.group_name || group || previous?.group || '').trim(),
      checkedAt,
    };
  }

  return added;
}

/* =======================
   DASHBOARD LOOKUP (only for emails the file does not know yet)
======================= */

async function lookupStatuses(api, apiBase, emails, log = console.log) {
  const found = {};
  const checkedAt = localDateTime();
  const queue = [...emails];
  let failures = 0;

  const worker = async () => {
    while (queue.length) {
      const email = queue.shift();
      try {
        const params = new URLSearchParams({ search: email, page_size: '10' });
        const payload = await api.get(`${apiBase}/admin/students/?${params}`);
        const list = Array.isArray(payload) ? payload : (payload?.data || []);
        const match = list.find((s) => cleanEmail(s?.user?.email || s?.email) === email);
        const status = normalizeStatus(match?.status);
        if (status) {
          found[email] = {
            status,
            name: String(match?.full_name || '').trim(),
            group: String(match?.group_name || match?.group?.name || '').trim(),
            checkedAt,
          };
        }
      } catch (error) {
        failures++;
        log(`⚠️ Dashboard status lookup failed for ${email}: ${String(error.message).split('\n')[0]}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, worker)
  );

  return { found, failures };
}

/* =======================
   CLEANING "missing from wavz.csv"
======================= */

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Rewrites the file with the same columns and the same UTF-8 BOM upload.py uses.
function writeMissingFromWavz(filePath, rows) {
  const content = '﻿' + [
    ['group', 'email', 'status', 'csv_file'],
    ...rows.map((row) => [row.group, row.email, row.status, row.csv_file]),
  ]
    .map((columns) => columns.map(csvEscape).join(','))
    .join('\r\n') + '\r\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

/* Removes every row whose student is not active on the dashboard.
   Returns { removed, kept, unknown }. */
async function cleanMissingFromWavz({
  api,
  apiBase,
  exportDir,
  students,
  parseCsvRows,
  log = console.log,
}) {
  const filePath = path.join(exportDir, MISSING_FROM_WAVZ_FILE);
  const result = { removed: 0, kept: 0, unknown: 0 };
  if (!fs.existsSync(filePath)) return result;

  let rows;
  try {
    rows = parseCsvRows(fs.readFileSync(filePath, 'utf-8'))
      .map((row) => ({
        group: String(row.group ?? row.Group ?? '').trim(),
        email: cleanEmail(row.email ?? row.Email),
        status: String(row.status ?? row.Status ?? '').trim(),
        csv_file: String(row.csv_file ?? row.CSV_File ?? row.csvFile ?? '').trim(),
      }))
      .filter((row) => row.email);
  } catch (error) {
    log(`⚠️ Could not read ${MISSING_FROM_WAVZ_FILE}: ${error.message}`);
    return result;
  }
  if (!rows.length) return result;

  // Anything the status file does not know yet is looked up now.
  const unknownEmails = [...new Set(rows.map((row) => row.email))].filter(
    (email) => !normalizeStatus(students[email]?.status)
  );
  if (unknownEmails.length) {
    log(`🔎 Checking the dashboard status of ${unknownEmails.length} student(s) from ${MISSING_FROM_WAVZ_FILE}...`);
    const { found } = await lookupStatuses(api, apiBase, unknownEmails, log);
    Object.assign(students, found);
  }

  const kept = [];
  const dropped = [];
  for (const row of rows) {
    const status = students[row.email]?.status;
    if (isNotActive(status)) {
      dropped.push({ ...row, dashboardStatus: status });
      continue;
    }
    if (!normalizeStatus(status)) result.unknown++;
    kept.push(row);
  }

  result.removed = dropped.length;
  result.kept = kept.length;

  if (!dropped.length) {
    if (result.unknown) {
      log(
        `ℹ️ ${MISSING_FROM_WAVZ_FILE}: ${result.unknown} student(s) have no dashboard status yet and stay in the list.`
      );
    }
    return result;
  }

  try {
    if (kept.length) {
      writeMissingFromWavz(filePath, kept);
    } else {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    log(
      `⚠️ Could not update ${MISSING_FROM_WAVZ_FILE} (is it open in Excel?): ` +
      `${String(error.message).split('\n')[0]}. It will be cleaned on the next run.`
    );
    return { ...result, removed: 0, kept: rows.length };
  }

  log(`🧹 ${MISSING_FROM_WAVZ_FILE}: removed ${dropped.length} student(s) who are not active on the dashboard:`);
  for (const row of dropped) {
    log(`   - ${row.email} (${row.group}) → dashboard status: ${row.dashboardStatus}`);
  }
  if (kept.length) {
    log(`   ${kept.length} student(s) are still active and left in the list.`);
  } else {
    log(`   The list is now empty and the file was removed.`);
  }
  if (result.unknown) {
    log(`   ${result.unknown} of them have no dashboard status yet and were kept.`);
  }

  return result;
}

module.exports = {
  STATUS_FILE,
  MISSING_FROM_WAVZ_FILE,
  normalizeStatus,
  isNotActive,
  readStatusMap,
  writeStatusMap,
  recordStatusesFromAttendance,
  lookupStatuses,
  cleanMissingFromWavz,
};
