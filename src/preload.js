const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('courtside', {
  onPanesConfig: (callback) => {
    ipcRenderer.on('panes-config', (_event, panes) => callback(panes));
  },
  onPaneStatus: (callback) => {
    ipcRenderer.on('pane-status', (_event, status) => callback(status));
  },
  onFocusChanged: (callback) => {
    ipcRenderer.on('focus-changed', (_event, payload) => callback(payload));
  },
  focusPane: (index) => ipcRenderer.send('focus-pane', index),
  retryPane: (index) => ipcRenderer.send('retry-pane', index),
});
