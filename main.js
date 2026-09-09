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

function startManagedProcess(event, taskId, taskLabel, command, args, options = {}) {
  if (currentProcess) {
    event.reply('log', '[WARN] Another process is already running.\n');
    return;
  }

  const cleanup = typeof options.cleanup === 'function' ? options.cleanup : null;
  logBuffer = [];
  logBufferSize = 0;
  currentTaskId = taskId;
  event.reply('log', `[START] Starting ${taskLabel}...\n`);

  currentProcess = spawn(command, args, {
    cwd: options.cwd || __dirname,
    env: options.env || process.env,
    windowsHide: true,
  });

  currentProcess.stdout.on('data', (data) => {
    const log = data.toString();
    appendToLogBuffer(log);
    event.reply('log', log);
  });

  currentProcess.stderr.on('data', (data) => {
    const log = `ERROR: ${data.toString()}`;
    appendToLogBuffer(log);
    event.reply('log', log);
  });

  currentProcess.on('error', (error) => {
    const log = `ERROR: Failed to start ${taskLabel}: ${error.message}\n`;
    appendToLogBuffer(log);
    event.reply('log', log);
  });

  currentProcess.on('close', (code, signal) => {
    if (cleanup) {
      try {
        cleanup();
      } catch (error) {
        event.reply('log', `Warning: cleanup failed: ${error.message}\n`);
      }
    }

    event.reply('log', `\n[OK] ${taskLabel} ended with code ${code}\n`);
    event.reply('process-ended', { code, signal, taskId });
    currentProcess = null;
    currentTaskId = null;
  });
}

ipcMain.on('start-attendance', (event, {
  dateFrom,
  dateTo,
  groupFilter,
  roundFilter,
  batchFilter,
  trackFilter,
}) => {
  const configPath = path.join(__dirname, 'temp_config.json');
  const config = {
    dateFrom,
    dateTo,
    groupFilter,
    roundFilter,
    batchFilter,
    trackFilter: normalizeTrack(trackFilter),
  };
  fs.writeFileSync(configPath, JSON.stringify(config));

  startManagedProcess(
    event,
    'attendance',
    'attendance automation',
    'node',
    ['run_attendance.js', '--config', configPath],
    {
      cwd: __dirname,
      cleanup: () => {
        if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath);
        }
      },
    }
  );
});

ipcMain.on('start-lms-upload', (event, {
  dateFrom,
  groupFilter,
  roundFilter,
  batchFilter,
  trackFilter,
  lmsView,
}) => {
  const onlyGroups = resolveOnlyGroups(groupFilter, batchFilter, trackFilter);
  const env = {
    ...process.env,
    START_FROM_DATE: dateFrom || '',
    ONLY_GROUPS: onlyGroups,
    LMS_ROUND: roundFilter || '',
    LMS_TRACK: normalizeTrack(trackFilter),
    LMS_COURSE_MODULE_ID: '',
    LMS_VIEW: lmsView || '4',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  };

  startManagedProcess(
    event,
    'lms-upload',
    'LMS upload',
    'python',
    ['-X', 'utf8', '-u', path.join('lms-bot', 'upload.py')],
    {
      cwd: __dirname,
      env,
    }
  );
});

ipcMain.on('start-lms-edit', (event, {
  groupFilter,
  roundFilter,
  batchFilter,
  trackFilter,
  lmsView,
}) => {
  const onlyGroups = resolveOnlyGroups(groupFilter, batchFilter, trackFilter);
  const env = {
    ...process.env,
    ONLY_GROUPS: onlyGroups,
    LMS_ROUND: roundFilter || '',
    LMS_TRACK: normalizeTrack(trackFilter),
    LMS_COURSE_MODULE_ID: '',
    LMS_VIEW: lmsView || '4',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  };

  startManagedProcess(
    event,
    'lms-edit',
    'LMS edit',
    'python',
    ['-X', 'utf8', '-u', path.join('lms-bot', 'edit.py')],
    {
      cwd: __dirname,
      env,
    }
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
  if (currentProcess) {
    const stoppedTask = currentTaskId || 'process';
    currentProcess.kill();
    currentProcess = null;
    currentTaskId = null;
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
