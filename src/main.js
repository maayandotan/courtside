const { app, components, BrowserWindow, WebContentsView } = require('electron');

const HEADER_HEIGHT = 56;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
    },
  });

  win.loadFile('src/renderer/index.html');

  const paneView = new WebContentsView();
  win.contentView.addChildView(paneView);
  paneView.webContents.loadURL('https://www.nba.com/watch');

  const layoutPane = () => {
    const { width, height } = win.getContentBounds();
    paneView.setBounds({
      x: 0,
      y: HEADER_HEIGHT,
      width,
      height: height - HEADER_HEIGHT,
    });
  };

  layoutPane();
  win.on('resize', layoutPane);
}

app.whenReady().then(async () => {
  await components.whenReady();
  console.log('Widevine component status:', components.status());
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
