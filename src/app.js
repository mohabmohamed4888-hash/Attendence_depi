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
  setupGroupPicker();
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

/* =======================
   GROUP PICKER
   The picked groups live in selectedGroups and are mirrored into the hidden
   groupFilter input, which is what the rest of the app reads. They show up as
   chips above the box, each with an x to drop it, and the list below scrolls.
======================= */

let selectedGroups = [];
let activeOptionIndex = -1;

function getSelectedGroups() {
  return [...selectedGroups];
}

function setSelectedGroups(groups, { save = true, refresh = true } = {}) {
  selectedGroups = parseGroupList(Array.isArray(groups) ? groups.join(',') : groups);

  const hidden = document.getElementById('groupFilter');
  if (hidden) hidden.value = selectedGroups.join(',');

  renderGroupChips();
  if (refresh) refreshGroupOptions();
  if (save) saveFormPreferences();
}

function addSelectedGroup(group) {
  const name = String(group || '').trim();
  if (!name) return;
  if (selectedGroups.some((g) => g.toUpperCase() === name.toUpperCase())) return;
  setSelectedGroups([...selectedGroups, name]);
}

function removeSelectedGroup(group) {
  setSelectedGroups(
    selectedGroups.filter((g) => g.toUpperCase() !== String(group).trim().toUpperCase())
  );
}

function renderGroupChips() {
  const container = document.getElementById('groupChips');
  if (!container) return;
  container.innerHTML = '';

  selectedGroups.forEach((group, index) => {
    const chip = document.createElement('span');
    chip.className = 'group-chip';

    const order = document.createElement('span');
    order.className = 'chip-order';
    order.textContent = `${index + 1}.`;
    chip.appendChild(order);

    const name = document.createElement('span');
    name.textContent = group;
    chip.appendChild(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${group}`;
    remove.setAttribute('aria-label', `Remove ${group}`);
    remove.disabled = isRunning;
    remove.addEventListener('click', () => removeSelectedGroup(group));
    chip.appendChild(remove);

    container.appendChild(chip);
  });

  if (selectedGroups.length > 1) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'group-chip chip-clear';
    clear.textContent = `Clear all (${selectedGroups.length})`;
    clear.disabled = isRunning;
    clear.addEventListener('click', () => setSelectedGroups([]));
    container.appendChild(clear);
  }
}

// The groups that can still be picked, narrowed by round, owner and track,
// and by whatever is typed in the search box.
function availableGroupChoices() {
  const roundFilter = document.getElementById('roundFilter')?.value || '';
  const batchFilter = document.getElementById('batchFilter')?.value || '';
  const trackFilter = getTrackFilter();
  const search = (document.getElementById('groupSearch')?.value || '').trim().toUpperCase();
  const taken = new Set(selectedGroups.map((group) => group.toUpperCase()));

  const ownerGroups = availableGroupBatches[batchFilter] || null;
  return (ownerGroups || availableGroups)
    .filter((group) => !taken.has(group.toUpperCase()))
    .filter((group) => !roundFilter || getGroupRound(group) === roundFilter)
    .filter((group) => matchesTrackFilter(group, trackFilter))
    .filter((group) => !search || group.toUpperCase().includes(search));
}

function refreshGroupOptions() {
  const list = document.getElementById('groupOptions');
  if (!list) return;

  const choices = availableGroupChoices();
  list.innerHTML = '';
  activeOptionIndex = -1;

  if (!choices.length) {
    const empty = document.createElement('div');
    empty.className = 'group-empty';
    empty.textContent = selectedGroups.length
      ? 'No other group matches the filters above.'
      : 'No group matches the filters above.';
    list.appendChild(empty);
    return;
  }

  choices.forEach((group) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'group-option';
    option.setAttribute('role', 'option');
    option.dataset.group = group;

    const name = document.createElement('span');
    name.textContent = group;
    option.appendChild(name);

    const track = getGroupTrack(group);
    if (track) {
      const tag = document.createElement('span');
      tag.className = 'option-track';
      tag.textContent = TRACK_LABELS[track] || track;
      option.appendChild(tag);
    }

    option.addEventListener('click', () => {
      addSelectedGroup(group);
      const search = document.getElementById('groupSearch');
      if (search) {
        search.value = '';
        search.focus();
      }
      refreshGroupOptions();
      openGroupOptions();
    });

    list.appendChild(option);
  });
}

/* The control panel scrolls, so a list opened near its bottom edge would be
   cut off. Give it the room that is left, and scroll the panel so it fits. */
function fitGroupOptions() {
  const list = document.getElementById('groupOptions');
  const picker = document.querySelector('.group-picker');
  const panel = document.querySelector('.control-panel');
  if (!list || list.hidden || !picker || !panel) return;

  const panelRect = panel.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();

  const roomBelow = panelRect.bottom - pickerRect.bottom - 16;
  const roomAfterScrolling = Math.min(panelRect.height - pickerRect.height - 24, 260);
  list.style.maxHeight = `${Math.max(140, Math.min(260, Math.max(roomBelow, roomAfterScrolling)))}px`;

  const overflow = list.getBoundingClientRect().bottom - panelRect.bottom;
  if (overflow > 0) panel.scrollTop += overflow + 12;
}

function openGroupOptions() {
  const list = document.getElementById('groupOptions');
  const search = document.getElementById('groupSearch');
  if (!list || search?.disabled) return;
  list.hidden = false;
  search?.setAttribute('aria-expanded', 'true');
  // Measured straight away: a window that is not painting (minimised, or in
  // the background) never runs requestAnimationFrame, and the list would then
  // stay clipped.
  fitGroupOptions();
}

function closeGroupOptions() {
  const list = document.getElementById('groupOptions');
  if (!list) return;
  list.hidden = true;
  activeOptionIndex = -1;
  document.getElementById('groupSearch')?.setAttribute('aria-expanded', 'false');
}

function moveActiveOption(step) {
  const options = [...document.querySelectorAll('#groupOptions .group-option')];
  if (!options.length) return;

  activeOptionIndex = (activeOptionIndex + step + options.length) % options.length;
  options.forEach((option, index) => option.classList.toggle('is-active', index === activeOptionIndex));
  options[activeOptionIndex].scrollIntoView({ block: 'nearest' });
}

function setupGroupPicker() {
  const search = document.getElementById('groupSearch');
  const toggle = document.getElementById('groupToggle');
  const picker = search?.closest('.group-picker');
  if (!search || !picker) return;

  search.addEventListener('focus', () => {
    refreshGroupOptions();
    openGroupOptions();
  });

  search.addEventListener('input', () => {
    refreshGroupOptions();
    openGroupOptions();
  });

  search.addEventListener('keydown', (keyEvent) => {
    if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
      keyEvent.preventDefault();
      openGroupOptions();
      moveActiveOption(keyEvent.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (keyEvent.key === 'Enter') {
      keyEvent.preventDefault();
      const options = [...document.querySelectorAll('#groupOptions .group-option')];
      // Enter picks the highlighted row, or the only row left after a search.
      const chosen = options[activeOptionIndex] || (options.length === 1 ? options[0] : null);
      if (chosen) chosen.click();
      return;
    }
    if (keyEvent.key === 'Escape') {
      closeGroupOptions();
      return;
    }
    // Backspace on an empty box drops the last chip.
    if (keyEvent.key === 'Backspace' && !search.value && selectedGroups.length) {
      removeSelectedGroup(selectedGroups[selectedGroups.length - 1]);
    }
  });

  toggle?.addEventListener('click', () => {
    const list = document.getElementById('groupOptions');
    if (list && !list.hidden) {
      closeGroupOptions();
      return;
    }
    refreshGroupOptions();
    openGroupOptions();
    search.focus();
  });

  document.addEventListener('click', (clickEvent) => {
    if (!picker.contains(clickEvent.target)) closeGroupOptions();
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

  updateTrackButtons(trackFilter);

  if (selectedGroups.length) {
    setSelectedGroups(
      selectedGroups.filter((group) => !conflictsWithTrackFilter(group, trackFilter)),
      { save: false, refresh: false }
    );
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
    if (selectedGroups.length && ownerGroups.length) {
      // Only the groups that do not belong to this owner are dropped; the rest
      // of what was picked stays.
      setSelectedGroups(
        selectedGroups.filter((group) => ownerGroups.includes(group)),
        { save: false, refresh: false }
      );
    }
  }

  if (groupFilter) groupFilter.disabled = isRunning;
  refreshGroupOptions();
  if (save) saveFormPreferences();
}

function setFormDisabled(disabled) {
  document.getElementById('dateFrom').disabled = disabled;
  document.getElementById('dateTo').disabled = disabled;
  document.getElementById('groupFilter').disabled = disabled;
  document.getElementById('groupSearch').disabled = disabled;
  document.getElementById('groupToggle').disabled = disabled;
  if (disabled) closeGroupOptions();
  renderGroupChips();
  document.getElementById('roundFilter').disabled = disabled;
  document.getElementById('batchFilter').disabled = disabled;
  document.getElementById('trackFilter').disabled = disabled;
  document.getElementById('lmsView').disabled = disabled;
  document.getElementById('newSessionLink').disabled = disabled;
  document.getElementById('forceReupload').disabled = disabled;
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
  // Deliberately not remembered between runs: it has to be ticked on purpose.
  const forceReupload = document.getElementById('forceReupload').checked;

  const chosenGroups = parseGroupList(groupFilter);
  groupFilter = chosenGroups.join(',');

  if (batchFilter) {
    roundFilter = '5';
    document.getElementById('roundFilter').value = '5';
    const ownerGroups = availableGroupBatches[batchFilter] || [];
    const outsiders = ownerGroups.length
      ? chosenGroups.filter((group) => !ownerGroups.includes(group))
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
    const wrongRound = chosenGroups.filter(
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

  const wrongTrack = chosenGroups.filter((group) => conflictsWithTrackFilter(group, trackFilter));
  if (wrongTrack.length) {
    addLogEntry(
      `These groups are not part of the ${TRACK_LABELS[trackFilter]} track: ${wrongTrack.join(', ')}`,
      'error'
    );
    return null;
  }

  return { dateFrom, dateTo, groupFilter, roundFilter, batchFilter, trackFilter, lmsView, forceReupload };
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
    // The hidden field was just restored; rebuild the chips from it.
    setSelectedGroups(document.getElementById('groupFilter')?.value || '', {
      save: false,
      refresh: false,
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
    // groupFilter is hidden and written by the picker, which saves by itself.
    if (!element || id === 'groupFilter') return;
    element.addEventListener('change', saveFormPreferences);
  });
}

function setupWheelScrolling() {
  document.addEventListener('wheel', (event) => {
    // A list that scrolls on its own keeps its own wheel: without this the
    // panel below it moved instead and the group list could not be scrolled.
    const ownScroller = event.target.closest('.group-options');
    if (ownScroller && ownScroller.scrollHeight > ownScroller.clientHeight) return;

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

// Replacing attendance that is already on the LMS is not something to do by
// accident, so the scope is shown and confirmed first.
function confirmForceReupload(formValues) {
  if (!formValues.forceReupload) return true;

  const groups = parseGroupList(formValues.groupFilter);
  return window.confirm(
    'Re-upload sessions that already have attendance?\n\n' +
    `Dates: ${formValues.dateFrom} to ${formValues.dateTo}\n` +
    `Groups: ${groups.length ? groups.join(', ') : (formValues.batchFilter || 'ALL GROUPS')}\n` +
    `Track: ${TRACK_LABELS[formValues.trackFilter]}\n\n` +
    'The attendance now on the LMS for those sessions is replaced by what is in the CSV files.\n' +
    'Untick the box to skip sessions that already have attendance.'
  );
}

// Attendance -> Sync / Edit sessions -> Upload, one after the other with no
// waiting in between. The main process stops the run if a step fails.
function startFullRun() {
  const formValues = getFormValues(true);
  if (!formValues) return;
  if (!confirmForceReupload(formValues)) {
    addLogEntry('Full run cancelled.', 'info');
    return;
  }

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
  if (!confirmForceReupload(formValues)) {
    addLogEntry('Upload cancelled.', 'info');
    return;
  }

  if (formValues.forceReupload) {
    addLogEntry('Re-upload option is ON: sessions that already have attendance will be uploaded again.', 'warning');
  }

  beginRun('lms-upload', 'Running LMS Upload');
  window.electron.startLmsUpload({
    dateFrom: formValues.dateFrom,
    groupFilter: formValues.groupFilter,
    roundFilter: formValues.roundFilter,
    batchFilter: formValues.batchFilter,
    trackFilter: formValues.trackFilter,
    lmsView: formValues.lmsView,
    forceReupload: formValues.forceReupload,
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
