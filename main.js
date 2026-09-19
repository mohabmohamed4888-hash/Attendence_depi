const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { GROUP_BATCHES } = require('./group_batches');
const ROUND_5_GROUP_IDS = require('./lms-bot/round5_groups.json');
const ROUND_5_NON_TECHNICAL_GROUP_IDS = require('./lms-bot/round5_nontechnical_groups.json');
const { normalizeTrack, getGroupTrack } = require('./group_tracks');
const { resolveGroupsWorkbookPath } = require('./group_workbook');

let mainWindow;
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

app.on('ready', createWindow);

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

      if (cleanup) {
        try {
          cleanup();
        } catch (error) {
          event.reply('log', `Warning: cleanup failed: ${error.message}\n`);
        }
      }

      event.reply('log', `\n[OK] ${label} ended with code ${code}\n`);
      if (currentProcess === child) {
        currentProcess = null;
        currentTaskId = null;
      }
      resolve({ code, signal });
    };

    child.stdout.on('data', (data) => {
      const log = data.toString();
      appendToLogBuffer(log);
      event.reply('log', log);
    });

    child.stderr.on('data', (data) => {
      const log = `ERROR: ${data.toString()}`;
      appendToLogBuffer(log);
      event.reply('log', log);
    });

    child.on('error', (error) => {
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

function lmsEditStep(config) {
  return {
    taskId: 'lms-edit',
    label: 'LMS edit',
    command: 'python',
    args: ['-X', 'utf8', '-u', path.join('lms-bot', 'edit.py')],
    options: { cwd: __dirname, env: lmsEnv(config) },
  };
}

function lmsUploadStep(config) {
  return {
    taskId: 'lms-upload',
    label: 'LMS upload',
    command: 'python',
    args: ['-X', 'utf8', '-u', path.join('lms-bot', 'upload.py')],
    options: {
      cwd: __dirname,
      env: lmsEnv(config, {
        START_FROM_DATE: config.dateFrom || '',
        FORCE_REUPLOAD: config.forceReupload ? 'true' : 'false',
      }),
    },
  };
}

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
   Attendance -> Sync/Edit sessions -> Upload, back to back with no idle time
   in between. The order is the one the data needs: the attendance export
   writes the CSVs and the session titles, the sync makes sure every session
   exists on the LMS, and only then is the attendance uploaded onto it.
   A step that fails stops the run: uploading onto sessions that were never
   synced would put attendance on the wrong rows.
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

  const steps = [
    { title: 'Attendance export', build: () => attendanceStep(config) },
    { title: 'Sync / Edit sessions', build: () => lmsEditStep(config) },
    { title: 'Upload attendance', build: () => lmsUploadStep(config) },
  ];

  let lastCode = 0;
  const startedAt = Date.now();

  try {
    for (let i = 0; i < steps.length; i++) {
      if (chainCancelled) break;

      const { title, build } = steps[i];
      event.reply('log', `\n${'='.repeat(70)}\n[FULL RUN] Step ${i + 1}/${steps.length}: ${title}\n${'='.repeat(70)}\n`);

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
        event.reply('log', `\n[FULL RUN] Stopped by user after step ${i + 1}/${steps.length}.\n`);
        break;
      }

      if (code !== 0) {
        event.reply(
          'log',
          `\n[FULL RUN] Step ${i + 1}/${steps.length} (${title}) ended with code ${code}. ` +
          `The remaining steps were not run — fix this one and start again.\n`
        );
        break;
      }
    }

    if (!chainCancelled && lastCode === 0) {
      const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
      event.reply('log', `\n${'='.repeat(70)}\n[FULL RUN] All 3 steps finished in ${minutes} minutes.\n${'='.repeat(70)}\n`);
    }
  } finally {
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
