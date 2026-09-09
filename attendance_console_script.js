async function attendanceConsoleScript({ rosterText, fileBase }) {
  window.ROSTER = String(rosterText || '').trim();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const STATUS_MAP = { Joined: 'P', 'Not-Joined': 'A' };

  if (!window.ROSTER) {
    console.error('❌ لازم تحط window.ROSTER الأول.');
    return;
  }

  const norm = (value) => String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokenSet = (value) => new Set(norm(value).split(' ').filter(Boolean));
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  const roster = window.ROSTER
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const emailMatch = line.match(emailRegex);
      if (!emailMatch) {
        console.warn('⚠️ ROSTER line has no valid email:', line);
        return null;
      }

      const email = emailMatch[0].trim().toLowerCase();
      const name = line
        .slice(0, emailMatch.index)
        .replace(/[\t,;|\-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      return { name, email, normalizedName: norm(name) };
    })
    .filter(Boolean)
    .filter((student) => student.name && student.email);

  if (!roster.length) {
    console.error('❌ Could not parse any students from ROSTER.');
    return;
  }

  console.log(`✅ ROSTER parsed: ${roster.length} students`);

  const exactMap = new Map();
  for (const student of roster) {
    if (!exactMap.has(student.normalizedName)) {
      exactMap.set(student.normalizedName, student.email);
    }
  }

  const getMatchScore = (attendanceName, rosterName) => {
    const attendanceTokens = [...tokenSet(attendanceName)];
    const rosterTokens = [...tokenSet(rosterName)];
    if (!attendanceTokens.length || !rosterTokens.length) return 0;

    const attendanceSet = new Set(attendanceTokens);
    const rosterSet = new Set(rosterTokens);
    let commonTokens = 0;
    for (const token of attendanceSet) {
      if (rosterSet.has(token)) commonTokens++;
    }

    const smallerSize = Math.min(attendanceSet.size, rosterSet.size);
    const largerSize = Math.max(attendanceSet.size, rosterSet.size);
    const smallerCoverage = commonTokens / smallerSize;
    const largerCoverage = commonTokens / largerSize;

    if (smallerSize >= 3 && commonTokens === smallerSize) {
      return 0.9 + (0.1 * largerCoverage);
    }

    return smallerCoverage * 0.7 + largerCoverage * 0.3;
  };

  const dialog = [...document.querySelectorAll(
    '[role="dialog"], [data-state="open"], .modal, .dialog'
  )].find((element) => (element.innerText || '').includes('Attendance Details')) || document;

  const scroller = [...dialog.querySelectorAll('*')]
    .filter((element) => {
      const style = getComputedStyle(element);
      const height = element.getBoundingClientRect().height;
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && height > 150;
    })
    .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];

  if (!scroller) {
    console.warn('❌ Could not find the scrollable attendance list.');
    return;
  }

  let previousScrollTop = -1;
  for (let attempt = 0; attempt < 80; attempt++) {
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(150);
    if (scroller.scrollTop === previousScrollTop) break;
    previousScrollTop = scroller.scrollTop;
  }

  scroller.scrollTop = 0;
  await sleep(300);

  const statusElements = [...dialog.querySelectorAll('*')].filter((element) => {
    const text = (element.textContent || '').trim();
    return text === 'Joined' || text === 'Not-Joined';
  });

  const extracted = [];
  const seenNames = new Set();

  for (const statusElement of statusElements) {
    const statusText = statusElement.textContent.trim();
    let rowElement = statusElement;

    for (let level = 0; level < 10; level++) {
      rowElement = rowElement.parentElement;
      if (!rowElement) break;

      const lines = (rowElement.innerText || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (!lines.includes(statusText)) continue;

      const name = lines.find((line) =>
        line !== 'Attendance Details' &&
        line !== 'Student' &&
        line !== 'Status' &&
        line !== 'Joined' &&
        line !== 'Not-Joined'
      );

      if (name && name.length > 2) {
        const nameKey = norm(name);
        if (!seenNames.has(nameKey)) {
          seenNames.add(nameKey);
          extracted.push({ name, statusText });
        }
        break;
      }
    }
  }

  if (extracted.length <= 2) {
    const textLines = (dialog.innerText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !['Attendance Details', 'Student', 'Status'].includes(line));

    const temporaryRecords = new Map();
    for (let index = 0; index < textLines.length - 1; index++) {
      const possibleName = textLines[index];
      const possibleStatus = textLines[index + 1];
      const validStatus = possibleStatus === 'Joined' || possibleStatus === 'Not-Joined';
      const validName = possibleName !== 'Joined' && possibleName !== 'Not-Joined';
      if (validStatus && validName) temporaryRecords.set(possibleName, possibleStatus);
    }

    extracted.length = 0;
    for (const [name, statusText] of temporaryRecords.entries()) {
      extracted.push({ name, statusText });
    }
  }

  if (!extracted.length) {
    console.error('❌ Could not extract attendance names.');
    return;
  }

  console.log(`✅ Attendance extracted: ${extracted.length} students`);

  const rows = [];
  const missing = [];
  const ambiguous = [];
  const usedEmails = new Set();

  for (const record of extracted) {
    const normalizedAttendanceName = norm(record.name);
    let email = exactMap.get(normalizedAttendanceName);
    let matchedRosterName = null;
    let matchScore = 1;

    if (!email) {
      const candidates = roster
        .map((student) => ({
          student,
          score: getMatchScore(record.name, student.name),
        }))
        .sort((a, b) => b.score - a.score);

      const best = candidates[0];
      const secondBest = candidates[1];
      const acceptableScore = best && best.score >= 0.72;
      const scoreDifference = best && secondBest ? best.score - secondBest.score : 1;
      const uniqueMatch = !secondBest || scoreDifference >= 0.06 || best.score >= 0.98;

      if (acceptableScore && uniqueMatch) {
        email = best.student.email;
        matchedRosterName = best.student.name;
        matchScore = best.score;
        console.log(
          `✅ Matched: "${record.name}" → "${best.student.name}" (${best.score.toFixed(2)})`
        );
      } else if (best && best.score >= 0.72) {
        ambiguous.push({
          attendanceName: record.name,
          firstCandidate: best.student.name,
          firstScore: best.score.toFixed(2),
          secondCandidate: secondBest?.student.name || '',
          secondScore: secondBest ? secondBest.score.toFixed(2) : '',
        });
      }
    } else {
      matchedRosterName = record.name;
    }

    if (!email) {
      missing.push(record.name);
      continue;
    }

    if (usedEmails.has(email)) {
      console.warn(`⚠️ Duplicate email skipped: ${email}`, record.name);
      continue;
    }

    usedEmails.add(email);
    rows.push({
      user_identifier: email,
      status: STATUS_MAP[record.statusText] || record.statusText,
      attendanceName: record.name,
      matchedRosterName,
      matchScore,
    });
  }

  console.log(`📊 Matched ${rows.length} of ${extracted.length} attendance students.`);
  if (missing.length) {
    console.warn(`⚠️ Names not found in ROSTER (${missing.length}):`, missing);
  }
  if (ambiguous.length) {
    console.warn(
      '⚠️ Ambiguous names were not exported to avoid assigning incorrect emails:',
      ambiguous
    );
  }

  if (!rows.length) {
    console.error('❌ No attendance names could be matched to ROSTER.');
    return;
  }

  const base = String(fileBase || 'FILE').trim();
  const fileName = `${base}.csv`.replace(/\s+/g, '_');
  const csvEscape = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const csvLines = [
    ['user_identifier', 'status'],
    ...rows
      .sort((a, b) => a.user_identifier.localeCompare(b.user_identifier))
      .map((row) => [row.user_identifier, row.status]),
  ].map((columns) => columns.map(csvEscape).join(','));

  const csvContent = '\ufeff' + csvLines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const downloadUrl = URL.createObjectURL(blob);
  const downloadLink = document.createElement('a');
  downloadLink.href = downloadUrl;
  downloadLink.download = fileName;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

  console.log(`✅ Exported ${rows.length} rows to CSV. File="${fileName}"`);
}

module.exports = { attendanceConsoleScript };
