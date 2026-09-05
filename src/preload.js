const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('courtside', {
  onPaneStatus: (callback) => {
    ipcRenderer.on('pane-status', (_event, status) => callback(status));
  },
  retryPane: () => ipcRenderer.send('retry-pane'),
});
