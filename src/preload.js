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
  onPaneSkipState: (callback) => {
    ipcRenderer.on('pane-skip-state', (_event, payload) => callback(payload));
  },
  onShowGrid: (callback) => {
    ipcRenderer.on('show-grid', () => callback());
  },
  focusPane: (index) => ipcRenderer.send('focus-pane', index),
  retryPane: (index) => ipcRenderer.send('retry-pane', index),
  jumpToQuarter: (index, quarter) => ipcRenderer.send('jump-to-quarter', { index, quarter }),
  nudgeQuarter: (index, direction) => ipcRenderer.send('nudge-quarter', { index, direction }),
  setSplitRatio: (ratio) => ipcRenderer.send('set-split-ratio', ratio),
  getHomeData: () => ipcRenderer.invoke('get-home-data'),
  getTeams: () => ipcRenderer.invoke('get-teams'),
  getFavoriteTeam: () => ipcRenderer.invoke('get-favorite-team'),
  setFavoriteTeam: (tricode) => ipcRenderer.send('set-favorite-team', tricode),
  openGame: (game) => ipcRenderer.send('open-game', game),
  showHome: () => ipcRenderer.send('show-home'),
});
