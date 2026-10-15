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
  getHomeData: (dateStr) => ipcRenderer.invoke('get-home-data', dateStr),
  getTeams: () => ipcRenderer.invoke('get-teams'),
  getFavoriteTeams: () => ipcRenderer.invoke('get-favorite-teams'),
  getUserName: () => ipcRenderer.invoke('get-user-name'),
  setUserName: (name) => ipcRenderer.send('set-user-name', name),
  setFavoriteTeam: (league, name) => ipcRenderer.send('set-favorite-team', { league, name }),
  showHome: () => ipcRenderer.send('show-home'),
  getEplHomeData: (dateStr) => ipcRenderer.invoke('get-epl-home-data', dateStr),
  getClHomeData: (dateStr) => ipcRenderer.invoke('get-cl-home-data', dateStr),
  getNflHomeData: (dateStr) => ipcRenderer.invoke('get-nfl-home-data', dateStr),
  getEuroLeagueHomeData: (dateStr) => ipcRenderer.invoke('get-euroleague-home-data', dateStr),
  getNflTeams: () => ipcRenderer.invoke('get-nfl-teams'),
  getEuroLeagueTeams: () => ipcRenderer.invoke('get-euroleague-teams'),
  openGames: (games) => ipcRenderer.send('open-games', games),
  addPane: (game) => ipcRenderer.send('add-pane', game),
  replacePane: (id, game) => ipcRenderer.send('replace-pane', { id, game }),
  closePane: (id) => ipcRenderer.send('close-pane', id),
  onHomeNotice: (callback) => {
    ipcRenderer.on('home-notice', (_event, payload) => callback(payload));
  },
});
