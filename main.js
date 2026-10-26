const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { RunMonitor, lineDecoder } = require('./run_monitor');
const monitor = new RunMonitor(require('path').join(__dirname, 'exports', 'gui_progress.json'));
let monitorTimer;
function publishMonitor(event) {
  if (monitorTimer) return;
  monitorTimer = setTimeout(() => { monitorTimer = null; monitor.save(); broadcast('run-progress', monitor.state); }, 120);
}
const fs = require('fs');
const { GROUP_BATCHES } = require('./group_batches');
const ROUND_5_GROUP_IDS = require('./lms-bot/round5_groups.json');
const ROUND_5_NON_TECHNICAL_GROUP_IDS = require('./lms-bot/round5_nontechnical_groups.json');
const { normalizeTrack, getGroupTrack } = require('./group_tracks');
const { resolveGroupsWorkbookPath } = require('./group_workbook');

let mainWindow;
let progressWindow;
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
function createProgressWindow() {
  if (progressWindow && !progressWindow.isDestroyed()) {
    if (progressWindow.isMinimized()) progressWindow.restore();
    progressWindow.show(); progressWindow.focus(); return;
  }
  const win = progressWindow = new BrowserWindow({
    title: 'DEPI · Groups & Sessions', width: 1440, height: 900,
    minWidth: 800, minHeight: 600, show: false, backgroundColor: '#08131f',
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, spellcheck: false, backgroundThrottling: false}
  });
  win.loadFile(path.join(__dirname, 'src', 'progress.html'));
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.on('closed', () => { progressWindow = null; });
}
ipcMain.handle('open-progress', () => { createProgressWindow(); return {ok: true}; });
ipcMain.handle('show-controls', () => {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
});
let currentProcess = null;
let currentTaskId = null;
let chainRunning = false;
let chainCancelled = false;
let logBuffer = [];
let logBufferSize = 0;
let groupsListCache = null;
const MAX_LOG_BUFFER_SIZE = 2 * 1024 * 1024;
const ROUND_5_LMS_GROUPS = [
  ...Object.keys(ROUND_5_GROUP_IDS),
  ...Object.keys(ROUND_5_NON_TECHNICAL_GROUP_IDS),
];
const isDevMode = process.argv.includes('--enable-logging');

// Favor GPU rendering in Electron; this often fixes sluggish scrolling
// compared with opening the same UI in a regular browser.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('num-raster-threads', '4');

function readGroupsList() {
  if (groupsListCache) return groupsListCache;
  const XLSX = require('xlsx');
  const workbookPath = resolveGroupsWorkbookPath(__dirname);
  const wb = XLSX.readFile(workbookPath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  groupsListCache = [
    ...new Set([
      ...rows.map((row) => String(row.group || '').trim()).filter(Boolean),
      ...ROUND_5_LMS_GROUPS,
      ...Object.values(GROUP_BATCHES).flat(),
    ]),
  ].sort();
  return groupsListCache;
}

function resolveOnlyGroups(groupFilter, batchFilter, trackFilter) {
  const selectedGroup = String(groupFilter || '').trim();
  if (selectedGroup) return selectedGroup;

  const track = normalizeTrack(trackFilter);
  const batchGroups = GROUP_BATCHES[String(batchFilter || '').toLowerCase()] || [];
  return batchGroups
    .filter((group) => track === 'all' || getGroupTrack(group) === track)
    .join(',');
}

function appendToLogBuffer(log) {
  logBuffer.push(log);
  logBufferSize += Buffer.byteLength(log, 'utf8');

  while (logBufferSize > MAX_LOG_BUFFER_SIZE && logBuffer.length > 1) {
    logBufferSize -= Buffer.byteLength(logBuffer.shift(), 'utf8');
  }
}

function createWindow() {
  const windowOptions = {
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 820,
    show: false,
    backgroundColor: '#08131f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  };

  const iconPath = path.join(__dirname, 'assets/icon.png');
  if (fs.existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadFile('src/index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });

  if (isDevMode) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    if (currentProcess) {
      currentProcess.kill();
    }
    mainWindow = null;
  });
}

app.on('ready', () => { createWindow(); if (process.argv.includes('--progress')) createProgressWindow(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

/* Runs one step and resolves with its exit code. It does NOT send
   'process-ended', so several steps can run one after another inside a single
   run (see 'start-full-run') while the interface stays busy throughout. */
function runStep(event, step) {
  return new Promise((resolve) => {
    const { taskId, label, command, args, options = {} } = step;
    const cleanup = typeof options.cleanup === 'function' ? options.cleanup : null;
    let settled = false;

    currentTaskId = taskId;
    if (!options.retry && !(chainRunning && taskId !== 'attendance')) monitor.start(taskId);
    else { monitor.state.running = true; monitor.state.task = taskId; }
    publishMonitor(event);
    let stderrSummary = '';
    const decoder = new StringDecoder('utf8');
    const lines = lineDecoder((line) => {
      if (line.startsWith('@@PROGRESS ')) {
        try { monitor.apply(JSON.parse(line.slice(11))); publishMonitor(event); } catch { /* invalid event stays out of state */ }
      } else { appendToLogBuffer(line + '\n'); event.reply('log', line + '\n'); }
    });
    event.reply('log', `[START] Starting ${label}...\n`);

    const child = spawn(command, args, {
      cwd: options.cwd || __dirname,
      env: options.env || process.env,
      windowsHide: true,
    });
    currentProcess = child;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;

      lines.push(decoder.end());
      lines.flush();
      if (code !== 0 && stderrSummary.trim()) monitor.state.reason = stderrSummary.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!chainRunning) monitor.end(code);
      publishMonitor(event);
      if (cleanup) {
        try {
          cleanup();
        } catch (error) {
          event.reply('log', `Warning: cleanup failed: ${error.message}\n`);
        }
      }

      event.reply('log', `\n[${code === 0 ? 'OK' : code == null ? 'STOP' : 'ERROR'}] ${label} ended with code ${code}\n`);
      if (currentProcess === child) {
        currentProcess = null;
        currentTaskId = null;
      }
      resolve({ code, signal });
    };

    child.stdout.on('data', (data) => {
      lines.push(decoder.write(data));
    });

    child.stderr.on('data', (data) => {
      const stderrText = data.toString();
      stderrSummary = (stderrSummary + stderrText).slice(-4000);
      const log = `ERROR: ${stderrText}`;
      appendToLogBuffer(log);
      event.reply('log', log);
    });

    child.on('error', (error) => {
      monitor.state.reason = `Failed to start ${label}: ${error.message}`;
      publishMonitor(event);
      const log = `ERROR: Failed to start ${label}: ${error.message}\n`;
      appendToLogBuffer(log);
      event.reply('log', log);
      // A process that never started emits 'error' and may never emit 'close'.
      finish(-1, null);
    });

    child.on('close', (code, signal) => finish(code, signal));
  });
}

function startManagedProcess(event, taskId, taskLabel, command, args, options = {}) {
  if (currentProcess || chainRunning) {
    event.reply('log', '[WARN] Another process is already running.\n');
    return;
  }

  logBuffer = [];
  logBufferSize = 0;
  runStep(event, { taskId, label: taskLabel, command, args, options }).then(
    ({ code, signal }) => {
      event.reply('process-ended', { code, signal, taskId });
    }
  );
}

/* =======================
   STEP BUILDERS
   The single buttons and the full run share these, so one flow can never
   drift from the other.
======================= */

function attendanceStep(config) {
  const configPath = path.join(__dirname, 'temp_config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      retrySessionId: config.retrySessionId,
      dateFrom: config.dateFrom,
      dateTo: config.dateTo,
      groupFilter: config.groupFilter,
      roundFilter: config.roundFilter,
      batchFilter: config.batchFilter,
      trackFilter: normalizeTrack(config.trackFilter),
    })
  );

  return {
    taskId: 'attendance',
    label: 'attendance automation',
    command: 'node',
    args: ['run_attendance.js', '--config', configPath],
    options: {
      cwd: __dirname,
      cleanup: () => {
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      },
    },
  };
}

function lmsEnv(config, extra = {}) {
  return {
    ...process.env,
    ONLY_GROUPS: resolveOnlyGroups(config.groupFilter, config.batchFilter, config.trackFilter),
    LMS_ROUND: config.roundFilter || '',
    LMS_TRACK: normalizeTrack(config.trackFilter),
    LMS_COURSE_MODULE_ID: '',
    LMS_VIEW: config.lmsView || '4',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    ...extra,
  };
}

// Every LMS button runs lms-bot/fast_sync.py: it first reads every group's
// LMS sessions table at once and checks what is missing (written to
// exports/lms_missing_sessions.csv), then does only that:
//   step 'sessions' = create / fix the sessions   (Sync / Edit Sessions)
//   step 'upload'   = upload the attendance        (Upload Attendance)
//   step 'all'      = both, in that order           (Fast Sync, Run Everything)
// With planOnly it only checks and changes nothing (Check Missing).
// The older lms-bot/edit.py and upload.py are left in place, unused here.
function lmsFastSyncStep(config, { step = 'all', planOnly = false, fullRun = false } = {}) {
  const ids = {
    sessions: ['lms-edit', 'LMS sync / edit sessions'],
    upload: ['lms-upload', 'LMS upload'],
    all: ['lms-fast-sync', 'LMS fast sync'],
  };
  const [taskId, label] = planOnly ? ['lms-fast-check', 'LMS missing check'] : ids[step];
  return {
    taskId,
    label,
    command: 'python',
    args: [
      '-X', 'utf8', '-u', path.join('lms-bot', 'fast_sync.py'),
      '--step', step,
      ...(planOnly ? ['--plan'] : []),
    ],
    options: {
      cwd: __dirname,
      env: lmsEnv(config, {
        START_FROM_DATE: config.dateFrom || '',
        END_AT_DATE: config.dateTo || '',
        RETRY_SESSION: config.retrySession ? JSON.stringify(config.retrySession) : '',
        FORCE_REUPLOAD: config.forceReupload ? 'true' : 'false',
        // Run Everything: the script prints its stages as 2-4 of 4.
        FULL_RUN_STAGES: fullRun ? '1' : '',
      }),
    },
  };
}

function lmsEditStep(config) {
  return lmsFastSyncStep(config, { step: 'sessions' });
}

function lmsUploadStep(config) {
  return lmsFastSyncStep(config, { step: 'upload' });
}

ipcMain.on('start-lms-fast-sync', (event, config) => {
  const step = lmsFastSyncStep(config, { planOnly: Boolean(config && config.planOnly) });
  startManagedProcess(event, step.taskId, step.label, step.command, step.args, step.options);
});

ipcMain.on('start-attendance', (event, config) => {
  const step = attendanceStep(config);
  startManagedProcess(event, step.taskId, step.label, step.command, step.args, step.options);
});

ipcMain.on('start-lms-upload', (event, config) => {
  const step = lmsUploadStep(config);
  startManagedProcess(event, step.taskId, step.label, step.command, step.args, step.options);
});

ipcMain.on('start-lms-edit', (event, config) => {
  const step = lmsEditStep(config);
  startManagedProcess(event, step.taskId, step.label, step.command, step.args, step.options);
});

/* =======================
   FULL RUN
   Attendance -> LMS (check missing -> sync sessions -> upload), back to back
   with no idle time in between. The order is the one the data needs: the
   attendance export writes the CSVs and the session titles, the LMS step
   checks what is missing, makes sure every session exists on the LMS, and
   only then uploads the attendance onto it.
   A step that fails stops the run.
======================= */

ipcMain.on('start-full-run', async (event, config) => {
  if (currentProcess || chainRunning) {
    event.reply('log', '[WARN] Another process is already running.\n');
    return;
  }

  chainRunning = true;
  chainCancelled = false;
  logBuffer = [];
  logBufferSize = 0;

  // The LMS step checks what is missing first, then creates / fixes the
  // sessions and uploads the attendance, in one browser session.
  // 4 stages in 2 processes: the export (stage 1), then one LMS run that
  // checks (2), creates / edits every session (3) and uploads (4) in one
  // browser session, printing its own stage lines.
  const steps = [
    { title: 'Stage 1/4: Attendance export', build: () => attendanceStep(config) },
    {
      title: 'Stages 2-4/4: Check missing -> Sync sessions -> Upload attendance',
      build: () => lmsFastSyncStep(config, { step: 'all', fullRun: true }),
    },
  ];

  let lastCode = 0;
  const startedAt = Date.now();

  try {
    for (let i = 0; i < steps.length; i++) {
      if (chainCancelled) break;

      const { title, build } = steps[i];
      event.reply('log', `\n${'='.repeat(70)}\n[FULL RUN] ${title}\n${'='.repeat(70)}\n`);

      let step;
      try {
        step = build();
      } catch (error) {
        event.reply('log', `\n[FULL RUN] Could not start ${title}: ${error.message}\n`);
        lastCode = -1;
        break;
      }

      const { code } = await runStep(event, step);
      lastCode = code;

      if (chainCancelled) {
        event.reply('log', `\n[FULL RUN] Stopped by user during ${title}.\n`);
        break;
      }

      if (code !== 0) {
        event.reply(
          'log',
          `\n[FULL RUN] ${title} ended with code ${code}. ` +
          `The remaining stages were not run - fix this one and start again.\n`
        );
        break;
      }
    }

    if (!chainCancelled && lastCode === 0) {
      const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
      event.reply('log', `\n${'='.repeat(70)}\n[FULL RUN] All 4 stages finished in ${minutes} minutes.\n${'='.repeat(70)}\n`);
    }
  } finally {
    monitor.end(chainCancelled ? null : lastCode);
    publishMonitor(event);
    chainRunning = false;
    chainCancelled = false;
    event.reply('process-ended', { code: lastCode, signal: null, taskId: 'full-run' });
  }
});

/* =======================
   CLEAN EXPORTS
   Deletes the per-session attendance CSVs that are already on the LMS.
   Runs only when the button is pressed (see exports_cleanup.js).
======================= */

ipcMain.on('clean-exports', (event) => {
  startManagedProcess(
    event,
    'clean-exports',
    'exports cleanup',
    'node',
    ['exports_cleanup.js'],
    { cwd: __dirname }
  );
});

ipcMain.on('start-dashboard-link-edit', (event, {
  dateFrom,
  dateTo,
  groupFilter,
  roundFilter,
  newLink,
}) => {
  const configPath = path.join(__dirname, 'temp_dashboard_link_config.json');
  const config = { dateFrom, dateTo, groupFilter, roundFilter, newLink };
  fs.writeFileSync(configPath, JSON.stringify(config));

  startManagedProcess(
    event,
    'dashboard-link-edit',
    'Dashboard session link edit',
    'node',
    ['edit_dashboard_links.js', '--config', configPath],
    {
      cwd: __dirname,
      cleanup: () => {
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      },
    }
  );
});

ipcMain.on('stop-process', (event) => {
  // Set first: a full run must not start its next step after this one is killed.
  if (chainRunning) chainCancelled = true;

  if (currentProcess) {
    const stoppedTask = currentTaskId || 'process';
    currentProcess.kill();
    event.reply('log', `\n[STOP] ${stoppedTask} stopped by user\n`);
  }
});

ipcMain.handle('get-logs', () => {
  return logBuffer.join('');
});

ipcMain.handle('clear-logs', () => {
  logBuffer = [];
  logBufferSize = 0;
  return true;
});

ipcMain.handle('get-groups', () => {
  return readGroupsList();
});

ipcMain.handle('get-group-batches', () => {
  return GROUP_BATCHES;
});

ipcMain.handle('get-group-tracks', () => {
  return Object.fromEntries(
    readGroupsList().map((group) => [group, getGroupTrack(group)])
  );
});

ipcMain.handle('get-run-progress', () => monitor.state);
ipcMain.handle('retry-session', (invokeEvent, id) => {
  const event = { sender:invokeEvent.sender, reply:(channel,...args) => { if(!invokeEvent.sender.isDestroyed()) invokeEvent.sender.send(channel,...args); } };
  if (currentProcess || chainRunning) return { ok: false, reason: 'Wait until the current run stops.' };
  const found = monitor.find(id);
  if (!found || !found.session.retryable) return { ok: false, reason: 'This session cannot be retried automatically.' };
  const { group, session } = found;
  if (!['error', 'interrupted'].some(status => Object.values(session.stages).includes(status))) return { ok:false, reason:'This session has no failed step.' };
  const config = { groupFilter:group.name, trackFilter:group.track, dateFrom:session.date, dateTo:session.date,
    retrySession:{ date:session.date, title:session.title } };
  const step = session.stages.export === 'error' || session.stages.export === 'interrupted'
    ? attendanceStep({...config,trackFilter:'all',retrySessionId:session.exportId})
    : lmsFastSyncStep(config, { step:'all' });
  step.options.retry = true;
  monitor.start('session-retry', true);
  runStep(event, step).then(({code,signal}) => broadcast('process-ended', {code,signal,taskId:'session-retry'}));
  return { ok:true };
});
