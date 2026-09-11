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
  onReturnHome: (callback) => {
    ipcRenderer.on('return-home', () => callback());
  },
  focusPane: (id) => ipcRenderer.send('focus-pane', id),
  retryPane: (id) => ipcRenderer.send('retry-pane', id),
  jumpToQuarter: (id, quarter) => ipcRenderer.send('jump-to-quarter', { id, quarter }),
  nudgeQuarter: (id, direction) => ipcRenderer.send('nudge-quarter', { id, direction }),
  setSplitRatio: (ratio) => ipcRenderer.send('set-split-ratio', ratio),
  getHomeData: () => ipcRenderer.invoke('get-home-data'),
  getTeams: () => ipcRenderer.invoke('get-teams'),
  getFavoriteTeam: () => ipcRenderer.invoke('get-favorite-team'),
  setFavoriteTeam: (tricode) => ipcRenderer.send('set-favorite-team', tricode),
  showHome: () => ipcRenderer.send('show-home'),
  getEplHomeData: () => ipcRenderer.invoke('get-epl-home-data'),
  getClHomeData: () => ipcRenderer.invoke('get-cl-home-data'),
  getNflHomeData: () => ipcRenderer.invoke('get-nfl-home-data'),
  getEuroLeagueHomeData: () => ipcRenderer.invoke('get-euroleague-home-data'),
  openGames: (games) => ipcRenderer.send('open-games', games),
  addPane: (game) => ipcRenderer.send('add-pane', game),
  replacePane: (id, game) => ipcRenderer.send('replace-pane', { id, game }),
  closePane: (id) => ipcRenderer.send('close-pane', id),
  onHomeNotice: (callback) => {
    ipcRenderer.on('home-notice', (_event, payload) => callback(payload));
  },
});
