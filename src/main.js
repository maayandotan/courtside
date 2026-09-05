const path = require('path');
const { app, components, ipcMain, BrowserWindow, WebContentsView } = require('electron');

const HEADER_HEIGHT = 56;
const PANE_MARGIN = 2;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1d63ff',
    icon: path.join(__dirname, '..', 'build', 'icon.icns'),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('src/renderer/index.html');

  const paneView = new WebContentsView();
  win.contentView.addChildView(paneView);

  let paneReady = false;

  const hidePane = () => paneView.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  const showPane = () => {
    const { width, height } = win.getContentBounds();
    paneView.setBounds({
      x: PANE_MARGIN,
      y: HEADER_HEIGHT + PANE_MARGIN,
      width: width - PANE_MARGIN * 2,
      height: height - HEADER_HEIGHT - PANE_MARGIN * 2,
    });
  };

  const sendStatus = (status) => win.webContents.send('pane-status', status);

  paneView.webContents.on('did-start-loading', () => sendStatus({ state: 'loading' }));

  paneView.webContents.on('did-finish-load', () => {
    paneReady = true;
    showPane();
    sendStatus({ state: 'ready' });
  });

  paneView.webContents.on('did-fail-load', (_event, _code, description) => {
    paneReady = false;
    hidePane();
    sendStatus({ state: 'error', message: description || 'Stream failed to load.' });
  });

  ipcMain.on('retry-pane', () => {
    hidePane();
    sendStatus({ state: 'loading' });
    paneView.webContents.reload();
  });

  win.on('resize', () => {
    if (paneReady) showPane();
  });

  hidePane();
  paneView.webContents.loadURL('https://www.nba.com/watch');
}

app.whenReady().then(async () => {
  await components.whenReady();
  console.log('Widevine component status:', components.status());
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
