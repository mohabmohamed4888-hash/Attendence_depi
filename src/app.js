let isRunning = false;
let layoutMode = 'horizontal';
let logPanelVisible = true;
let activeTaskId = null;
let liveLogEntry = null;
let pendingScrollFrame = null;
let availableGroups = [];
let availableGroupBatches = {};
let groupTracks = {};
let logEntryCount = 0;
let pendingLogMessages = [];
let pendingLogFlushFrame = null;

const MAX_VISIBLE_LOG_ENTRIES = 500;
const LOG_PLACEHOLDER_TEXTS = new Set(['Ready to start...', 'Log cleared.']);
const FORM_PREFERENCES_KEY = 'attendanceFormPreferencesV1';
const FORM_FIELD_IDS = [
  'dateFrom',
  'dateTo',
  'roundFilter',
  'batchFilter',
  'trackFilter',
  'groupFilter',
  'newSessionLink',
  'lmsView',
];
const TRACK_LABELS = {
  all: 'All Groups',
  technical: 'Technical',
  nontechnical: 'Non-Technical',
};

document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
  loadFormPreferences();
  setupFormPreferenceSaving();
  setupWheelScrolling();
  setupTimeUpdater();
  setupLogListener();
  setupProcessEndedListener();
  loadThemePreference();
  loadLayoutPreferences();
  loadGroupOptions();
});

function initializeApp() {
  const today = new Date();
  const twoWeeksAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);
  const formatDate = (date) => date.toISOString().split('T')[0];

  document.getElementById('dateFrom').value = formatDate(twoWeeksAgo);
  document.getElementById('dateTo').value = formatDate(today);
}

function setupTimeUpdater() {
  setInterval(() => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    document.getElementById('time').textContent = `${hours}:${minutes}:${seconds}`;
  }, 1000);
}

function setupLogListener() {
  window.electron.onLog((message) => {
    addLogEntry(message);
  });
}

function setupProcessEndedListener() {
  window.electron.onProcessEnded(({ code }) => {
    isRunning = false;
    activeTaskId = null;
    liveLogEntry = null;
    setFormDisabled(false);
    setActionButtonsRunning(false);
    document.getElementById('stopBtn').disabled = true;
    updateStatus(code === 0 ? 'Completed' : 'Ready');
  });
}

async function loadGroupOptions() {
  try {
    const [groups, batches, tracks] = await Promise.all([
      window.electron.getGroups(),
      window.electron.getGroupBatches(),
      window.electron.getGroupTracks(),
    ]);
    availableGroups = groups || [];
    availableGroupBatches = batches || {};
    groupTracks = tracks || {};
    handleBatchFilterChange({ save: false });
    refreshGroupOptions();
  } catch (error) {
    addLogEntry(`Warning: failed to load groups list: ${error.message}`, 'warning');
  }
}

function refreshGroupOptions() {
  const roundFilter = document.getElementById('roundFilter')?.value || '';
  const batchFilter = document.getElementById('batchFilter')?.value || '';
  const trackFilter = getTrackFilter();
  const dataList = document.getElementById('groupsList');
  if (!dataList) return;
  dataList.innerHTML = '';

  const ownerGroups = availableGroupBatches[batchFilter] || null;
  const sourceGroups = ownerGroups || availableGroups;

  sourceGroups
    .filter((group) => !roundFilter || getGroupRound(group) === roundFilter)
    .filter((group) => matchesTrackFilter(group, trackFilter))
    .forEach((group) => {
      const option = document.createElement('option');
      option.value = group;
      dataList.appendChild(option);
    });
}

function getTrackFilter() {
  return document.getElementById('trackFilter')?.value || 'all';
}

function getGroupTrack(groupName) {
  return groupTracks[String(groupName || '').trim()] || '';
}

function matchesTrackFilter(groupName, trackFilter) {
  if (!trackFilter || trackFilter === 'all') return true;
  return getGroupTrack(groupName) === trackFilter;
}

// Lenient check used for validation: a group we have no track data for yet
// must not be rejected.
function conflictsWithTrackFilter(groupName, trackFilter) {
  if (!trackFilter || trackFilter === 'all') return false;
  const track = getGroupTrack(groupName);
  return Boolean(track) && track !== trackFilter;
}

function setTrackFilter(track) {
  const select = document.getElementById('trackFilter');
  if (!select || select.disabled) return;
  select.value = TRACK_LABELS[track] ? track : 'all';
  handleTrackFilterChange();
}

function handleTrackFilterChange({ save = true } = {}) {
  const select = document.getElementById('trackFilter');
  if (select && !TRACK_LABELS[select.value]) {
    select.value = 'all';
  }

  const trackFilter = getTrackFilter();
  const groupFilter = document.getElementById('groupFilter');

  updateTrackButtons(trackFilter);

  if (groupFilter?.value.trim()) {
    groupFilter.value = parseGroupList(groupFilter.value)
      .filter((group) => !conflictsWithTrackFilter(group, trackFilter))
      .join(', ');
  }

  refreshGroupOptions();
  if (save) saveFormPreferences();
}

function updateTrackButtons(trackFilter) {
  document.querySelectorAll('#trackToggle .track-btn').forEach((button) => {
    const isActive = button.dataset.track === trackFilter;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
    button.disabled = isRunning;
  });
}

function getGroupRound(groupName) {
  return String(groupName || '').trim().toUpperCase().match(/^[A-Z]{3,4}([45])/)?.[1] || '';
}

// The group box takes several groups, separated by a comma. They are run one
// after the other, in the order they were typed.
function parseGroupList(raw) {
  const seen = new Set();
  const groups = [];
  for (const part of String(raw || '').split(/[,;\r\n]+/)) {
    const name = part.trim();
    if (!name || seen.has(name.toUpperCase())) continue;
    seen.add(name.toUpperCase());
    groups.push(name);
  }
  return groups;
}

function handleBatchFilterChange({ save = true } = {}) {
  const batchFilter = document.getElementById('batchFilter')?.value || '';
  const roundFilter = document.getElementById('roundFilter');
  const groupFilter = document.getElementById('groupFilter');

  if (batchFilter) {
    roundFilter.value = '5';
    const ownerGroups = availableGroupBatches[batchFilter] || [];
    if (groupFilter.value && ownerGroups.length) {
      // Only the groups that do not belong to this owner are dropped; the rest
      // of what was typed stays.
      groupFilter.value = parseGroupList(groupFilter.value)
        .filter((group) => ownerGroups.includes(group))
        .join(', ');
    }
  }

  groupFilter.disabled = isRunning;
  refreshGroupOptions();
  if (save) saveFormPreferences();
}

function setFormDisabled(disabled) {
  document.getElementById('dateFrom').disabled = disabled;
  document.getElementById('dateTo').disabled = disabled;
  document.getElementById('groupFilter').disabled = disabled;
  document.getElementById('roundFilter').disabled = disabled;
  document.getElementById('batchFilter').disabled = disabled;
  document.getElementById('trackFilter').disabled = disabled;
  document.getElementById('lmsView').disabled = disabled;
  document.getElementById('newSessionLink').disabled = disabled;
  updateTrackButtons(getTrackFilter());

  if (!disabled) {
    handleBatchFilterChange({ save: false });
  }
}

function setActionButtonsRunning(running) {
  document.getElementById('startBtn').disabled = running;
  document.getElementById('uploadBtn').disabled = running;
  document.getElementById('editBtn').disabled = running;
  document.getElementById('dashboardLinkBtn').disabled = running;
  document.getElementById('fullRunBtn').disabled = running;
  document.getElementById('cleanExportsBtn').disabled = running;
}

function getFormValues(requireRound = false) {
  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo = document.getElementById('dateTo').value;
  let groupFilter = document.getElementById('groupFilter').value.trim();
  let roundFilter = document.getElementById('roundFilter').value;
  const batchFilter = document.getElementById('batchFilter').value;
  const trackFilter = getTrackFilter();
  const lmsView = document.getElementById('lmsView').value;

  const selectedGroups = parseGroupList(groupFilter);
  groupFilter = selectedGroups.join(',');

  if (batchFilter) {
    roundFilter = '5';
    document.getElementById('roundFilter').value = '5';
    const ownerGroups = availableGroupBatches[batchFilter] || [];
    const outsiders = ownerGroups.length
      ? selectedGroups.filter((group) => !ownerGroups.includes(group))
      : [];
    if (outsiders.length) {
      addLogEntry(`These groups do not belong to ${batchFilter}: ${outsiders.join(', ')}`, 'error');
      return null;
    }
  }

  if (!dateFrom || !dateTo) {
    addLogEntry('Please enter both dates.', 'error');
    return null;
  }

  if (dateFrom > dateTo) {
    addLogEntry('Date From must be earlier than or equal to Date To.', 'error');
    return null;
  }

  if (requireRound && !roundFilter) {
    addLogEntry('Please select Round 4 or Round 5.', 'error');
    return null;
  }

  if (requireRound) {
    const wrongRound = selectedGroups.filter(
      (group) => getGroupRound(group) && getGroupRound(group) !== roundFilter
    );
    if (wrongRound.length) {
      addLogEntry(
        `These groups are not in Round ${roundFilter}: ` +
        wrongRound.map((group) => `${group} (Round ${getGroupRound(group)})`).join(', '),
        'error'
      );
      return null;
    }
  }

  const wrongTrack = selectedGroups.filter((group) => conflictsWithTrackFilter(group, trackFilter));
  if (wrongTrack.length) {
    addLogEntry(
      `These groups are not part of the ${TRACK_LABELS[trackFilter]} track: ${wrongTrack.join(', ')}`,
      'error'
    );
    return null;
  }

  return { dateFrom, dateTo, groupFilter, roundFilter, batchFilter, trackFilter, lmsView };
}

function loadFormPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_PREFERENCES_KEY) || '{}');
    FORM_FIELD_IDS.forEach((id) => {
      const element = document.getElementById(id);
      if (element && typeof saved[id] === 'string') {
        element.value = saved[id];
      }
    });
    handleTrackFilterChange({ save: false });
    handleBatchFilterChange({ save: false });
  } catch (error) {
    console.warn('Failed to load saved form preferences:', error);
  }
}

function saveFormPreferences() {
  const values = {};
  FORM_FIELD_IDS.forEach((id) => {
    values[id] = document.getElementById(id)?.value || '';
  });
  localStorage.setItem(FORM_PREFERENCES_KEY, JSON.stringify(values));
}

function setupFormPreferenceSaving() {
  FORM_FIELD_IDS.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    const eventName = id === 'groupFilter' ? 'input' : 'change';
    element.addEventListener(eventName, saveFormPreferences);
  });
}

function setupWheelScrolling() {
  document.addEventListener('wheel', (event) => {
    const scrollContainer = event.target.closest('.control-panel, .log-viewer');
    if (!scrollContainer || scrollContainer.scrollHeight <= scrollContainer.clientHeight) return;

    const atTop = scrollContainer.scrollTop <= 0;
    const atBottom =
      scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 1;
    const canScroll = (event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom);
    if (!canScroll) return;

    event.preventDefault();
    scrollContainer.scrollTop += event.deltaY;
  }, { passive: false });
}

function beginRun(taskId, statusLabel) {
  isRunning = true;
  activeTaskId = taskId;
  setActionButtonsRunning(true);
  document.getElementById('stopBtn').disabled = false;
  setFormDisabled(true);
  updateStatus(statusLabel);
}

function startProcess() {
  const formValues = getFormValues(true);
  if (!formValues) return;

  beginRun('attendance', 'Running Attendance');
  window.electron.startAttendance(formValues);
}

// Attendance -> Sync / Edit sessions -> Upload, one after the other with no
// waiting in between. The main process stops the run if a step fails.
function startFullRun() {
  const formValues = getFormValues(true);
  if (!formValues) return;

  beginRun('full-run', 'Running Everything');
  addLogEntry('Full run: Attendance -> Sync / Edit Sessions -> Upload Attendance', 'info');
  window.electron.startFullRun(formValues);
}

// Deletes the session CSVs that are already on the LMS. Files waiting for a
// re-upload are kept by the cleanup itself.
function cleanExports() {
  if (isRunning) {
    addLogEntry('Wait for the running operation to finish first.', 'error');
    return;
  }

  const confirmed = window.confirm(
    'Delete the session CSV files in exports?\n\n' +
    'Files still waiting for an LMS re-upload are kept, and so are the session titles and the reports.\n' +
    'Anything deleted can be produced again by running the attendance export for those dates.\n\n' +
    'This cannot be undone.'
  );
  if (!confirmed) {
    addLogEntry('Exports cleanup cancelled.', 'info');
    return;
  }

  beginRun('clean-exports', 'Cleaning Exports');
  window.electron.cleanExports();
}

function startLmsUpload() {
  const formValues = getFormValues();
  if (!formValues) return;

  beginRun('lms-upload', 'Running LMS Upload');
  window.electron.startLmsUpload({
    dateFrom: formValues.dateFrom,
    groupFilter: formValues.groupFilter,
    roundFilter: formValues.roundFilter,
    batchFilter: formValues.batchFilter,
    trackFilter: formValues.trackFilter,
    lmsView: formValues.lmsView,
  });
}

function startLmsEdit() {
  const formValues = getFormValues();
  if (!formValues) return;

  beginRun('lms-edit', 'Running LMS Edit');
  window.electron.startLmsEdit({
    groupFilter: formValues.groupFilter,
    roundFilter: formValues.roundFilter,
    batchFilter: formValues.batchFilter,
    trackFilter: formValues.trackFilter,
    lmsView: formValues.lmsView,
  });
}

function startDashboardLinkEdit() {
  const formValues = getFormValues(true);
  if (!formValues) return;

  const newLink = document.getElementById('newSessionLink').value.trim();
  const linkGroups = parseGroupList(formValues.groupFilter);
  if (linkGroups.length !== 1) {
    addLogEntry(
      linkGroups.length
        ? 'Edit Dashboard Link works on one group at a time. Leave a single group in the box.'
        : 'Choose one Group Name before editing dashboard session links.',
      'error'
    );
    return;
  }
  try {
    const parsed = new URL(newLink);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    addLogEntry('Enter a valid New Session Link starting with http:// or https://.', 'error');
    return;
  }

  const confirmed = window.confirm(
    `Replace the session link for every matching session?\n\n` +
    `Group: ${formValues.groupFilter}\n` +
    `Dates: ${formValues.dateFrom} to ${formValues.dateTo}\n` +
    `New link: ${newLink}\n\n` +
    `Only Live sessions will be updated. Physical sessions will be skipped.`
  );
  if (!confirmed) return;

  saveFormPreferences();
  beginRun('dashboard-link-edit', 'Editing Dashboard Links');
  window.electron.startDashboardLinkEdit({
    dateFrom: formValues.dateFrom,
    dateTo: formValues.dateTo,
    groupFilter: formValues.groupFilter,
    roundFilter: formValues.roundFilter,
    newLink,
  });
}

function stopProcess() {
  if (!isRunning) return;

  isRunning = false;
  activeTaskId = null;
  liveLogEntry = null;
  window.electron.stopProcess();
  setActionButtonsRunning(false);
  document.getElementById('stopBtn').disabled = true;
  setFormDisabled(false);
  updateStatus('Stopped');
}

function clearLogs() {
  const logViewer = document.getElementById('logViewer');
  logViewer.innerHTML = '<div class="log-entry initial">Log cleared.</div>';
  liveLogEntry = null;
  logEntryCount = 0;
  pendingLogMessages = [];
  document.getElementById('logCount').textContent = '(0)';
  window.electron.clearLogs();
}

function addLogEntry(message, type = 'info') {
  pendingLogMessages.push({ message, type });
  if (pendingLogFlushFrame) return;

  pendingLogFlushFrame = requestAnimationFrame(flushPendingLogs);
}

function flushPendingLogs() {
  const logViewer = document.getElementById('logViewer');
  const messages = pendingLogMessages;
  pendingLogMessages = [];
  pendingLogFlushFrame = null;
  const shouldFollowOutput =
    logViewer.scrollHeight - logViewer.scrollTop - logViewer.clientHeight < 80;

  messages.forEach(({ message, type }) => renderLogMessage(logViewer, message, type));
  trimOldLogEntries(logViewer);
  updateLogCount();

  if (shouldFollowOutput) queueLogScrollToBottom(logViewer);
}

function renderLogMessage(logViewer, message, type = 'info') {
  const normalizedMessage = normalizeLogMessage(message);

  if (!normalizedMessage) return;

  removePlaceholderEntries(logViewer);

  const lines = normalizedMessage.split('\n');
  const endsWithNewline = normalizedMessage.endsWith('\n');

  lines.forEach((line, index) => {
    const isLastSegment = index === lines.length - 1;
    const isTrailingNewlineMarker = isLastSegment && endsWithNewline && line === '';

    if (isTrailingNewlineMarker) {
      return;
    }

    const effectiveType = inferLogType(line || normalizedMessage, type);
    const isCompleteLine = !isLastSegment || endsWithNewline;

    if (liveLogEntry) {
      liveLogEntry.textContent += line;
      applyLogEntryType(liveLogEntry, inferLogType(liveLogEntry.textContent, effectiveType));

      if (isCompleteLine) {
        finalizeLogEntry(liveLogEntry);
        liveLogEntry = null;
      }
      return;
    }

    const entry = createLogEntry(line, effectiveType);
    logViewer.appendChild(entry);
    logEntryCount++;

    if (isCompleteLine) {
      finalizeLogEntry(entry);
    } else {
      liveLogEntry = entry;
    }
  });

}

function trimOldLogEntries(logViewer) {
  const excess = logEntryCount - MAX_VISIBLE_LOG_ENTRIES;
  if (excess <= 0) return;

  let removed = 0;
  let entry = logViewer.firstElementChild;
  while (entry && removed < excess) {
    const nextEntry = entry.nextElementSibling;
    if (!entry.classList.contains('initial') && entry !== liveLogEntry) {
      entry.remove();
      removed++;
    }
    entry = nextEntry;
  }
  logEntryCount -= removed;
}

function normalizeLogMessage(message) {
  return String(message ?? '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u0008/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/âš ï¸|⚠️/g, '[WARN]')
    .replace(/âœ…|✅/g, '[OK]')
    .replace(/ðŸš€|🚀/g, '[START]')
    .replace(/â›”|⛔/g, '[STOP]')
    .replace(/âŒ|❌/g, '[ERROR]');
}

function inferLogType(message, fallbackType = 'info') {
  if (fallbackType && fallbackType !== 'info') {
    return fallbackType;
  }

  const text = String(message || '');
  const lowerText = text.toLowerCase();

  if (
    text.includes('ERROR') ||
    text.includes('[ERROR]') ||
    lowerText.includes('traceback') ||
    lowerText.includes('exception')
  ) {
    return 'error';
  }

  if (text.includes('[WARN]') || text.includes('[STOP]') || lowerText.includes('warning')) {
    return 'warning';
  }

  if (text.includes('[OK]') || text.includes('[START]') || lowerText.includes('success')) {
    return 'success';
  }

  return 'info';
}

function removePlaceholderEntries(logViewer) {
  const placeholders = logViewer.querySelectorAll('.log-entry.initial');
  placeholders.forEach((entry) => {
    if (LOG_PLACEHOLDER_TEXTS.has(entry.textContent.trim())) {
      entry.remove();
    }
  });
}

function createLogEntry(text, type) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  applyLogEntryType(entry, type);
  entry.textContent = text || ' ';

  if (!text) {
    entry.classList.add('blank');
  }

  return entry;
}

function applyLogEntryType(entry, type) {
  entry.classList.remove('info', 'success', 'warning', 'error');
  entry.classList.add(type || 'info');
}

function finalizeLogEntry(entry) {
  if (!entry.textContent.trim()) {
    entry.textContent = ' ';
    entry.classList.add('blank');
  } else {
    entry.classList.remove('blank');
  }
}

function updateLogCount() {
  document.getElementById('logCount').textContent = `(${logEntryCount})`;
}

function queueLogScrollToBottom(logViewer) {
  if (pendingScrollFrame) {
    cancelAnimationFrame(pendingScrollFrame);
  }

  pendingScrollFrame = requestAnimationFrame(() => {
    logViewer.scrollTop = logViewer.scrollHeight;
    pendingScrollFrame = null;
  });
}

function updateStatus(status) {
  const statusElement = document.getElementById('status');
  statusElement.textContent = status;
  const normalizedStatus = String(status || '').toLowerCase();

  let state = 'ready';
  if (normalizedStatus.includes('running')) state = 'running';
  else if (normalizedStatus.includes('stop')) state = 'stopped';
  else if (normalizedStatus.includes('complete')) state = 'completed';

  statusElement.dataset.state = state;
}

function loadThemePreference() {
  const savedTheme = localStorage.getItem('themeMode') || 'midnight';
  applyTheme(savedTheme);
}

function changeTheme(theme) {
  applyTheme(theme);
  localStorage.setItem('themeMode', theme);
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;

  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.value = theme;
  }
}

function loadLayoutPreferences() {
  const saved = localStorage.getItem('layoutMode');
  const savedLogVisibility = localStorage.getItem('logPanelVisible');

  if (saved) layoutMode = saved;
  if (savedLogVisibility !== null) logPanelVisible = savedLogVisibility === 'true';

  applyLayout();
  updateLayoutButtons();
}

function toggleLayout() {
  layoutMode = layoutMode === 'horizontal' ? 'vertical' : 'horizontal';
  localStorage.setItem('layoutMode', layoutMode);
  applyLayout();
  updateLayoutButtons();
}

function toggleLogPanel() {
  logPanelVisible = !logPanelVisible;
  localStorage.setItem('logPanelVisible', logPanelVisible);
  applyLayout();
  updateLayoutButtons();
}

function applyLayout() {
  const mainContent = document.querySelector('.main-content');
  const logPanel = document.querySelector('.log-panel');

  mainContent.classList.remove('horizontal', 'vertical');
  mainContent.classList.add(layoutMode === 'vertical' ? 'vertical' : 'horizontal');

  if (logPanelVisible) logPanel.classList.remove('hidden');
  else logPanel.classList.add('hidden');
}

function updateLayoutButtons() {
  const layoutBtn = document.getElementById('layoutToggle');
  const toggleLogBtn = document.getElementById('toggleLogBtn');

  if (layoutMode === 'horizontal') {
    layoutBtn.textContent = 'Vertical Layout';
    layoutBtn.title = 'Switch to vertical layout';
  } else {
    layoutBtn.textContent = 'Horizontal Layout';
    layoutBtn.title = 'Switch to horizontal layout';
  }

  if (logPanelVisible) {
    toggleLogBtn.textContent = 'Hide Log';
    toggleLogBtn.title = 'Hide log panel';
  } else {
    toggleLogBtn.textContent = 'Show Log';
    toggleLogBtn.title = 'Show log panel';
  }
}

window.addEventListener('beforeunload', () => {
  if (isRunning) {
    window.electron.stopProcess();
  }
});
