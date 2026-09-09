require('dotenv').config({ path: '../.env' });
const { chromium } = require('../node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { matchesTrack } = require('../group_tracks');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const seen = [];
  let sessionApiHeaders = null;
  page.on('response', async (response) => {
    const request = response.request();
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;
    const url = response.url();
    if (!/session|attendance/i.test(url)) return;
    if (/\/api\/v1\/admin\/sessions\//.test(url)) {
      sessionApiHeaders = request.headers();
    }
    const contentType = response.headers()['content-type'] || '';
    let preview = '';
    if (contentType.includes('json')) {
      preview = (await response.text().catch(() => '')).slice(0, 1000);
    }
    seen.push({ status: response.status(), method: request.method(), url, preview });
  });

  await page.goto('https://dashboard.depi.eyouthbusiness.com/auth/login');
  await page.fill('input[type="email"]', process.env.LOGIN_EMAIL);
  await page.fill('#password', process.env.LOGIN_PASSWORD);
  await page.click('button:has-text("Login")');
  await page.waitForLoadState('networkidle');
  await page.goto('https://dashboard.depi.eyouthbusiness.com/super_admin/sessions?date_from=2026-07-18&date_to=2026-08-13&round=second');
  await page.waitForLoadState('networkidle');
  let next = 'https://back.depi.eyouthbusiness.com/api/v1/admin/sessions/?date_from=2026-07-18&date_to=2026-08-13&round=second';
  const sessions = [];
  while (next) {
    const response = await page.request.get(next.replace('http://', 'https://'), {
      headers: sessionApiHeaders || {},
    });
    if (!response.ok()) throw new Error(`API ${response.status()}: ${next}`);
    const payload = await response.json();
    sessions.push(...(payload.data || []));
    next = payload.pagination?.next || null;
  }
  const normalized = sessions.map((session) => ({
      id: session.id,
      group: session.group?.label || '',
      groupValue: session.group?.value || '',
      date: session.date || '',
      name: session.name || '',
      focus: session.focus || '',
      finished: Boolean(session.is_finished),
      status: session.status_by_trainer || '',
  }));
  const counts = {};
  for (const session of normalized) {
    const key = `${session.focus}|${session.finished}|${session.status}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const nonTechnicalFinished = [...new Map(normalized
    .filter((session) => session.finished && session.focus === 'soft_skill' && matchesTrack(session.group, 'nontechnical'))
    .map((session) => [session.id, session])).values()];
  const targetGroupValues = [...new Map(normalized
    .filter((session) => matchesTrack(session.group, 'nontechnical') && session.groupValue)
    .map((session) => [session.group, session.groupValue])).entries()];
  const byGroupResults = await Promise.all(targetGroupValues.map(async ([groupName, groupValue]) => {
    let groupNext = `https://back.depi.eyouthbusiness.com/api/v1/admin/sessions/?date_from=2026-07-18&date_to=2026-08-13&round=second&group=${encodeURIComponent(groupValue)}`;
    const rows = [];
    while (groupNext) {
      const response = await page.request.get(groupNext.replace('http://', 'https://'), { headers: sessionApiHeaders || {} });
      if (!response.ok()) throw new Error(`Group API ${response.status()}: ${groupName}`);
      const payload = await response.json();
      rows.push(...(payload.data || []));
      groupNext = payload.pagination?.next || null;
    }
    return rows;
  }));
  const reliableTarget = [...new Map(byGroupResults.flat()
    .filter((session) => session.is_finished && session.focus === 'soft_skill')
    .map((session) => [session.id, {
      id: session.id,
      group: session.group?.label || '',
      date: session.date || '',
      name: session.name || '',
      focus: session.focus || '',
      finished: Boolean(session.is_finished),
      status: session.status_by_trainer || '',
    }])).values()];
  const existingIds = new Set();
  const titlesDir = path.resolve('../exports/Non Technical groups/CSV Titles');
  for (const file of fs.readdirSync(titlesDir).filter((name) => name.endsWith('.csv'))) {
    const text = fs.readFileSync(path.join(titlesDir, file), 'utf8');
    for (const id of text.matchAll(/\/sessions\/([0-9a-f-]{36})/gi)) existingIds.add(id[1]);
  }
  const missing = reliableTarget.filter((session) => !existingIds.has(session.id));
  const audit = {
    total: normalized.length,
    counts,
    targetUniqueCount: nonTechnicalFinished.length,
    reliableTargetCount: reliableTarget.length,
    existingTargetIds: reliableTarget.filter((session) => existingIds.has(session.id)).length,
    missing,
  };
  console.log(JSON.stringify(audit, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
