/* =======================
   GROUP ROSTER SYNC
   Students who show up in a session's attendance but are missing from the
   group's roster in groups.xlsx used to be listed in "Lms missing names.csv"
   and added by hand: search the name on the dashboard students page, copy the
   email and the group, and append a "Name<TAB>email" line to that group's
   roster cell. This module does exactly that after every attendance run:

     1. every missing student (this run + the ones still listed in the CSV) is
        searched on the dashboard API behind /super_admin/students?search=...
     2. the student is appended to the roster of the group the dashboard lists
        them in, as one new line at the end of the cell, the same way the
        sheet is edited by hand
     3. groups.xlsx is patched in place (only that cell changes; fonts, wrap
        text, widths and the table are untouched) after a backup copy is made
     4. students that could not be matched stay in the CSV with a reason
======================= */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const MISSING_NAMES_FILE = 'Lms missing names.csv';
const ROSTER_ADDITIONS_FILE = 'Roster additions.csv';
const BACKUP_DIR_NAME = 'groups_backups';
const SEARCH_PAGE_SIZE = 50;

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function parseRosterEmails(rosterText) {
  const emails = new Set();
  for (const line of String(rosterText || '').split(/\r?\n/)) {
    const match = line.match(EMAIL_REGEX);
    if (match) emails.add(match[0].trim().toLowerCase());
  }
  return emails;
}

const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim();
const cleanEmail = (email) => String(email || '').trim().toLowerCase();

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Plain comma-separated parsing (RFC 4180 quoting, optional BOM). SheetJS
// guesses the separator of a CSV from its content and picks "|" for the
// session-title files, which is how their rows were never recognised.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = (rows.shift() || []).map((h) => String(h).trim());
  return rows
    .filter((cells) => cells.some((cell) => String(cell).trim() !== ''))
    .map((cells) => Object.fromEntries(header.map((name, idx) => [name, cells[idx] ?? ''])));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Playwright request errors carry a multi-line call log (including the auth
// header), so only the first line is ever written to logs or reports.
function shortError(error) {
  return String(error?.message || error).split('\n')[0].trim();
}

async function withRetry(fn, retries = 6, delay = 400) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      await sleep(delay);
    }
  }
  throw lastError;
}

// Local time, e.g. "2026-09-19 14:05:09" (the run log and Excel are local too).
function localDateTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// File-name safe version: "2026-09-19_14-05-09".
function timestamp() {
  return localDateTime().replace(' ', '_').replace(/:/g, '-');
}

/* =======================
   MISSING STUDENTS (candidates + CSV report)
======================= */

function candidateKey(candidate) {
  return candidate.email ? `email:${candidate.email}` : `name:${normalize(candidate.name)}`;
}

// One entry per student. The same student is usually missing from several
// sessions of the same group, and may also still be listed in the CSV.
function dedupeCandidates(list) {
  const byKey = new Map();
  for (const raw of list || []) {
    const candidate = {
      name: cleanName(raw.name),
      email: cleanEmail(raw.email),
      group: String(raw.group || '').trim(),
    };
    if (!candidate.name && !candidate.email) continue;

    const key = candidateKey(candidate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
    } else {
      if (!existing.name) existing.name = candidate.name;
      if (!existing.group) existing.group = candidate.group;
    }
  }
  return [...byKey.values()];
}

function readMissingNamesCsv(filePath, log) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const rows = parseCsvRows(fs.readFileSync(filePath, 'utf-8'));
    return rows.map((row) => ({
      name: row.name ?? row.Name,
      email: row.email ?? row.Email,
      group: row.group ?? row.Group,
    }));
  } catch (error) {
    log(`⚠️ Could not read ${path.basename(filePath)}: ${shortError(error)}`);
    return [];
  }
}

async function writeMissingNamesCsv(filePath, unresolved, log) {
  if (!unresolved.length) {
    if (fs.existsSync(filePath)) {
      await withRetry(() => fs.unlinkSync(filePath));
      log(`🧹 ${path.basename(filePath)} removed: no student is left to add by hand`);
    }
    return null;
  }

  const rows = [...unresolved].sort(
    (a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)
  );
  const content = '﻿' + [
    ['name', 'email', 'group', 'reason'],
    ...rows.map((row) => [row.name, row.email, row.group, row.reason]),
  ]
    .map((columns) => columns.map(csvEscape).join(','))
    .join('\r\n');

  await withRetry(() => fs.writeFileSync(filePath, content, 'utf-8'));
  return filePath;
}

async function appendAdditionsReport(filePath, additions) {
  if (!additions.length) return;
  const header = ['added_at', 'group', 'name', 'email', 'attended_group', 'dashboard_status', 'dashboard_id'];
  const addedAt = localDateTime();
  const lines = additions.map((add) =>
    [addedAt, add.group, add.name, add.email, add.attendedGroup, add.status, add.dashboardId]
      .map(csvEscape)
      .join(',')
  );
  const isNew = !fs.existsSync(filePath);
  const content = (isNew ? `﻿${header.join(',')}\r\n` : '') + lines.join('\r\n') + '\r\n';
  await withRetry(() => fs.appendFileSync(filePath, content, 'utf-8'));
}

/* =======================
   DASHBOARD LOOKUP
   Same search as the students page: GET /admin/students/?search=<name or email>
======================= */

const studentEmail = (s) => cleanEmail(s?.user?.email || s?.email);
const studentName = (s) => cleanName(s?.full_name || s?.name);
const studentGroup = (s) =>
  String(s?.group_name || s?.group?.name || s?.group?.code || s?.group?.label || '').trim();

async function searchStudents(api, apiBase, query) {
  const params = new URLSearchParams({ search: query, page_size: String(SEARCH_PAGE_SIZE) });
  const payload = await api.get(`${apiBase}/admin/students/?${params}`);
  const students = Array.isArray(payload) ? payload : (payload?.data || []);
  const count = Number(payload?.pagination?.count ?? students.length);
  return { students, count };
}

// Returns { student } or { reason }. The email is the safest key (it is the
// one the attendance records carry); the exact name is the fallback for
// students whose email changed or was never exported.
async function findStudentOnDashboard(api, apiBase, { name, email }) {
  if (email) {
    const { students } = await searchStudents(api, apiBase, email);
    const match = students.find((s) => studentEmail(s) === email);
    if (match) return { student: match };
  }

  if (!name) return { reason: 'Not found on the dashboard (unknown email and no name to search)' };

  const { students, count } = await searchStudents(api, apiBase, name);
  if (!count) {
    return {
      reason: email
        ? 'Not found on the dashboard (neither the email nor the name)'
        : 'Not found on the dashboard',
    };
  }

  const exact = students.filter((s) => normalize(studentName(s)) === normalize(name));
  if (exact.length === 1) {
    const student = exact[0];
    const note = email && studentEmail(student) !== email
      ? `dashboard email is ${studentEmail(student)}, attendance had ${email}`
      : '';
    return { student, note };
  }
  if (exact.length > 1) return { reason: `${exact.length} students with exactly this name on the dashboard` };
  if (count === 1 && !email) return { student: students[0] };
  return { reason: `${count} similar names on the dashboard, none an exact match` };
}

/* =======================
   WORKBOOK PATCH
   groups.xlsx is edited in place: only the roster cells that gain students
   are rewritten inside the sheet XML, everything else in the file stays
   byte for byte the same (styles, wrap text, column widths, the table).
======================= */

function locateRosterCells(wb) {
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) throw new Error('the groups workbook has no data');

  const range = XLSX.utils.decode_range(ws['!ref']);
  const headerRow = range.s.r;
  let groupCol = -1;
  let rosterCol = -1;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const header = normalize(ws[XLSX.utils.encode_cell({ r: headerRow, c })]?.v);
    if (header === 'group') groupCol = c;
    if (header === 'roster') rosterCol = c;
  }
  if (groupCol < 0 || rosterCol < 0) {
    throw new Error('the groups workbook needs "group" and "roster" columns');
  }

  const rowByGroup = new Map();
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const group = normalize(ws[XLSX.utils.encode_cell({ r, c: groupCol })]?.v);
    if (group && !rowByGroup.has(group)) rowByGroup.set(group, r);
  }

  return { sheetName, ws, rosterCol, rowByGroup };
}

function readPart(cfb, partPath) {
  const entry = XLSX.CFB.find(cfb, partPath);
  return entry ? Buffer.from(entry.content).toString('utf8') : null;
}

// workbook.xml -> first <sheet r:id> -> workbook.xml.rels -> worksheet part.
function firstSheetPartPath(cfb) {
  const fallback = '/xl/worksheets/sheet1.xml';
  const workbookXml = readPart(cfb, '/xl/workbook.xml');
  const relsXml = readPart(cfb, '/xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relsXml) return fallback;

  const sheetTag = workbookXml.match(/<(?:[\w.-]+:)?sheet\b[^>]*>/);
  const relId = sheetTag?.[0].match(/\b(?:[\w.-]+:)?id="([^"]+)"/)?.[1];
  if (!relId) return fallback;

  const escaped = relId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const relTag = relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bId="${escaped}"[^>]*>`));
  const target = relTag?.[0].match(/\bTarget="([^"]+)"/)?.[1];
  if (!target) return fallback;
  return target.startsWith('/') ? target : `/xl/${target.replace(/^\.\//, '')}`;
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Replaces one <c r="B57" ...>...</c> element with an inline-string cell that
// keeps the same style index (s="..."), so wrap text and fonts stay as they are.
function replaceCellInSheetXml(xml, address, value) {
  const cellPattern = new RegExp(
    `<((?:[\\w.-]+:)?)c\\b([^>]*?)\\br="${address}"([^>]*?)(?:/>|>[\\s\\S]*?</(?:[\\w.-]+:)?c>)`
  );
  const match = xml.match(cellPattern);
  if (!match) throw new Error(`cell ${address} was not found in the sheet XML`);

  const prefix = match[1];
  const style = `${match[2]} ${match[3]}`.match(/\bs="([^"]+)"/)?.[1];
  const cell =
    `<${prefix}c r="${address}"${style ? ` s="${style}"` : ''} t="inlineStr">` +
    `<${prefix}is><${prefix}t xml:space="preserve">${escapeXml(value)}</${prefix}t></${prefix}is>` +
    `</${prefix}c>`;
  return xml.slice(0, match.index) + cell + xml.slice(match.index + match[0].length);
}

// New students go at the end of the cell, one "Name<TAB>email" per line,
// exactly like typing them in by hand.
function appendRosterLines(rosterText, students) {
  const current = String(rosterText || '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\s*\n)+\s*$/, '');
  const lines = students.map((s) => `${s.name}\t${s.email}`);
  return current ? `${current}\n${lines.join('\n')}` : lines.join('\n');
}

function verifyWorkbook(originalBuffer, outputBuffer, sheetName, edits) {
  const before = XLSX.read(originalBuffer, { type: 'buffer' }).Sheets[sheetName];
  const after = XLSX.read(outputBuffer, { type: 'buffer' }).Sheets[sheetName];
  if (!after || after['!ref'] !== before['!ref']) {
    throw new Error('verification failed: the sheet range changed');
  }

  const text = (v) => (v == null ? '' : String(v));
  const expectedByAddress = new Map(edits.map((edit) => [edit.address, edit.value]));
  const range = XLSX.utils.decode_range(before['!ref']);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const address = XLSX.utils.encode_cell({ r, c });
      const expected = expectedByAddress.has(address)
        ? expectedByAddress.get(address)
        : before[address]?.v;
      if (text(expected) !== text(after[address]?.v)) {
        throw new Error(`verification failed: cell ${address} does not match`);
      }
    }
  }
}

// additions: [{ group, name, email }]. Returns the students actually written
// (emails already in the cell on disk are skipped) and the backup path.
async function appendStudentsToWorkbook(workbookPath, additions, { backupDir } = {}) {
  const original = fs.readFileSync(workbookPath);
  const wb = XLSX.read(original, { type: 'buffer' });
  const { sheetName, ws, rosterCol, rowByGroup } = locateRosterCells(wb);

  const perGroup = new Map();
  for (const add of additions) {
    const key = normalize(add.group);
    if (!perGroup.has(key)) perGroup.set(key, { group: add.group, students: [] });
    perGroup.get(key).students.push(add);
  }

  const edits = [];
  const applied = [];
  for (const { group, students } of perGroup.values()) {
    const row = rowByGroup.get(normalize(group));
    if (row == null) throw new Error(`group ${group} is not in ${path.basename(workbookPath)}`);

    const address = XLSX.utils.encode_cell({ r: row, c: rosterCol });
    const current = ws[address]?.v;
    if (!String(current ?? '').trim()) {
      throw new Error(`group ${group} has an empty roster cell (${address})`);
    }

    const present = parseRosterEmails(current);
    const fresh = students.filter((s) => !present.has(s.email));
    if (!fresh.length) continue;

    edits.push({ group, address, value: appendRosterLines(current, fresh) });
    applied.push(...fresh);
  }
  if (!edits.length) return { applied, edits, backupPath: null };

  const CFB = XLSX.CFB;
  const cfb = CFB.read(original, { type: 'buffer' });
  const sheetPart = firstSheetPartPath(cfb);
  const entry = CFB.find(cfb, sheetPart);
  if (!entry) throw new Error(`${sheetPart} is missing from the workbook`);

  let xml = Buffer.from(entry.content).toString('utf8');
  for (const edit of edits) xml = replaceCellInSheetXml(xml, edit.address, edit.value);
  entry.content = Buffer.from(xml, 'utf8');
  entry.size = entry.content.length;
  const output = CFB.write(cfb, { type: 'buffer', fileType: 'zip', compression: true });

  verifyWorkbook(original, output, sheetName, edits);

  const extension = path.extname(workbookPath);
  const backupPath = backupDir
    ? path.join(backupDir, `${path.basename(workbookPath, extension)}_${timestamp()}${extension}`)
    : null;
  const tmpPath = `${workbookPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, output);
    if (backupPath) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(workbookPath, backupPath);
    }
    await withRetry(() => fs.renameSync(tmpPath, workbookPath), 8, 500);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    if (backupPath) { try { fs.unlinkSync(backupPath); } catch {} }
    if (error.code === 'EBUSY' || error.code === 'EPERM') {
      throw new Error(`${path.basename(workbookPath)} is locked (is it open in Excel?). Close it and run again.`);
    }
    throw error;
  }

  return { applied, edits, backupPath };
}

/* =======================
   SYNC
======================= */

// candidates: [{ name, email, group }] found missing in this run. The students
// still listed in "Lms missing names.csv" are retried too, every run.
// rosterByGroup: Map(normalize(group) -> { group, roster }); the rows are
// updated in place when the workbook write succeeds, so the caller builds its
// CSVs from the new rosters.
async function syncMissingStudents({
  api,
  apiBase,
  workbookPath,
  rosterByGroup,
  candidates,
  exportDir,
  log = console.log,
}) {
  const missingCsvPath = path.join(exportDir, MISSING_NAMES_FILE);
  const previous = readMissingNamesCsv(missingCsvPath, log);
  const queue = dedupeCandidates([...(candidates || []), ...previous]);

  const result = {
    additions: [],
    unresolved: [],
    alreadyPresent: [],
    backupPath: null,
    missingCsvPath: null,
  };

  if (!queue.length) {
    result.missingCsvPath = await writeMissingNamesCsv(missingCsvPath, [], log);
    return result;
  }

  log(
    `🔎 Looking up ${queue.length} missing students on the dashboard ` +
    `(${dedupeCandidates(candidates).length} from this run, ` +
    `${dedupeCandidates(previous).length} from ${MISSING_NAMES_FILE})...`
  );

  const planned = [];
  const plannedKeys = new Set();
  let fatalReason = '';

  for (const candidate of queue) {
    const label = candidate.name || candidate.email;
    const unresolved = (reason) => {
      result.unresolved.push({ ...candidate, reason });
      log(`❓ ${label}: ${reason}`);
    };

    if (fatalReason) {
      result.unresolved.push({ ...candidate, reason: fatalReason });
      continue;
    }

    let found;
    try {
      found = await findStudentOnDashboard(api, apiBase, candidate);
    } catch (error) {
      const reason = `Dashboard lookup failed: ${shortError(error)}`;
      if (error.fatal) fatalReason = reason;
      unresolved(reason);
      continue;
    }

    if (!found.student) {
      unresolved(found.reason);
      continue;
    }

    const student = found.student;
    const email = studentEmail(student);
    const name = studentName(student) || candidate.name;
    const group = studentGroup(student);

    if (!email) { unresolved('The dashboard profile has no email'); continue; }
    if (!group) { unresolved('The dashboard profile has no group'); continue; }

    const groupRow = rosterByGroup.get(normalize(group));
    if (!groupRow || !String(groupRow.roster || '').trim()) {
      unresolved(`Group ${group} has no roster in ${path.basename(workbookPath)}`);
      continue;
    }

    const plannedKey = `${normalize(group)}|${email}`;
    if (plannedKeys.has(plannedKey)) continue;
    if (parseRosterEmails(groupRow.roster).has(email)) {
      result.alreadyPresent.push({ name, email, group });
      log(`✔️ ${name} <${email}> is already in the ${group} roster`);
      continue;
    }

    plannedKeys.add(plannedKey);
    const movedNote = candidate.group && normalize(candidate.group) !== normalize(group)
      ? ` (attended ${candidate.group}, but the dashboard lists them in ${group})`
      : '';
    const statusNote = student.status && normalize(student.status) !== 'active'
      ? ` [dashboard status: ${student.status}]`
      : '';
    log(`➕ ${name} <${email}> → ${group}${movedNote}${found.note ? ` — ${found.note}` : ''}${statusNote}`);
    planned.push({
      group,
      name,
      email,
      attendedGroup: candidate.group || '',
      status: String(student.status || ''),
      dashboardId: String(student.id || ''),
    });
  }

  if (planned.length) {
    try {
      const { applied, edits, backupPath } = await appendStudentsToWorkbook(workbookPath, planned, {
        backupDir: path.join(exportDir, BACKUP_DIR_NAME),
      });

      for (const edit of edits) {
        const groupRow = rosterByGroup.get(normalize(edit.group));
        if (groupRow) groupRow.roster = edit.value;
      }

      for (const p of planned.filter((entry) => !applied.includes(entry))) {
        result.alreadyPresent.push({ name: p.name, email: p.email, group: p.group });
        log(`✔️ ${p.name} <${p.email}> was already in the ${p.group} roster on disk`);
      }

      result.additions = applied;
      result.backupPath = backupPath;
      if (applied.length) {
        await appendAdditionsReport(path.join(exportDir, ROSTER_ADDITIONS_FILE), applied);
        log(
          `💾 ${path.basename(workbookPath)} updated: ${applied.length} students added to ` +
          `${edits.length} group roster(s); backup: ${backupPath}`
        );
      }
    } catch (error) {
      const reason = `Found on the dashboard but ${path.basename(workbookPath)} could not be updated: ${shortError(error)}`;
      log(`❌ ${reason}`);
      for (const p of planned) {
        result.unresolved.push({
          name: p.name,
          email: p.email,
          group: p.attendedGroup || p.group,
          reason: `${reason} (dashboard group: ${p.group})`,
        });
      }
    }
  }

  // The report is usually open in Excel while people work through it, and a
  // locked file must not throw away what was just done above.
  try {
    result.missingCsvPath = await writeMissingNamesCsv(missingCsvPath, result.unresolved, log);
  } catch (error) {
    log(
      `⚠️ Could not update ${MISSING_NAMES_FILE} (is it open in Excel?): ${shortError(error)}. ` +
      'It will be refreshed on the next run.'
    );
    result.missingCsvPath = fs.existsSync(missingCsvPath) ? missingCsvPath : null;
  }
  return result;
}

module.exports = {
  MISSING_NAMES_FILE,
  ROSTER_ADDITIONS_FILE,
  BACKUP_DIR_NAME,
  normalize,
  parseRosterEmails,
  parseCsvRows,
  dedupeCandidates,
  findStudentOnDashboard,
  appendRosterLines,
  replaceCellInSheetXml,
  appendStudentsToWorkbook,
  syncMissingStudents,
};
