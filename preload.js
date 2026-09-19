const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  startAttendance: (config) => ipcRenderer.send('start-attendance', config),
  startFullRun: (config) => ipcRenderer.send('start-full-run', config),
  cleanExports: () => ipcRenderer.send('clean-exports'),
  startLmsUpload: (config) => ipcRenderer.send('start-lms-upload', config),
  startLmsEdit: (config) => ipcRenderer.send('start-lms-edit', config),
  startDashboardLinkEdit: (config) => ipcRenderer.send('start-dashboard-link-edit', config),
  stopProcess: () => ipcRenderer.send('stop-process'),
  onLog: (callback) => ipcRenderer.on('log', (event, message) => callback(message)),
  onProcessEnded: (callback) => ipcRenderer.on('process-ended', (event, payload) => callback(payload)),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  getGroups: () => ipcRenderer.invoke('get-groups'),
  getGroupBatches: () => ipcRenderer.invoke('get-group-batches'),
  getGroupTracks: () => ipcRenderer.invoke('get-group-tracks'),
});
