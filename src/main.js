const fs = require('fs');
const path = require('path');
const { app, components, globalShortcut, ipcMain, BrowserWindow, WebContentsView } = require('electron');

const HEADER_HEIGHT = 56;
const PANE_MARGIN = 2;

// Parses an HLS media playlist and finds the segment right after the
// largest gap between #EXT-X-DISCONTINUITY markers, restricted to the
// middle of the broadcast. The single longest gap overall is often the
// pregame show (before Q1), not halftime — so we only consider
// candidates roughly in the 30%-70% window of total runtime, where
// halftime actually falls.
function findSecondHalfStart(manifestText) {
  const lines = manifestText.split('\n');
  let elapsed = 0;
  const discontinuities = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF:')) {
      elapsed += parseFloat(line.slice('#EXTINF:'.length));
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuities.push(elapsed);
    }
  }
  const total = elapsed;
  if (discontinuities.length === 0) return null;

  const lowerBound = total * 0.3;
  const upperBound = total * 0.7;

  let prev = 0;
  let maxGap = -1;
  let target = null;
  for (const d of discontinuities) {
    const gap = d - prev;
    if (d >= lowerBound && d <= upperBound && gap > maxGap) {
      maxGap = gap;
      target = d;
    }
    prev = d;
  }
  return { target, maxGap, total };
}

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

  // Watch the focused pane's own network traffic for its HLS media
  // playlist. This isn't DRM-protected (only the segments it references
  // are), but the CDN's anti-scraping checks reject a replayed fetch —
  // so instead we intercept the real in-flight request/response via CDP
  // Fetch domain and read the body Chromium already has, then let the
  // response continue untouched.
  const debug = paneView.webContents.debugger;
  let variantManifestText = null;
  let attempts = 0;
  const MAX_ATTEMPTS = 30;

  try {
    debug.attach('1.3');
    debug
      .sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*.m3u8*', requestStage: 'Response' }] })
      .catch((e) => console.error('Fetch.enable failed:', e.message));
    debug.on('message', (_event, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const { requestId, request, responseStatusCode } = params;
      const isMaster = /\/index\.m3u8/i.test(request.url);

      if (variantManifestText || isMaster || attempts >= MAX_ATTEMPTS) {
        debug.sendCommand('Fetch.continueResponse', { requestId }).catch(() => {});
        if (variantManifestText) debug.sendCommand('Fetch.disable').catch(() => {});
        return;
      }

      if (responseStatusCode >= 300 && responseStatusCode < 400) {
        // Redirect leg (e.g. CDN token issuance hop) — no content here.
        debug.sendCommand('Fetch.continueResponse', { requestId }).catch(() => {});
        return;
      }

      attempts += 1;
      debug
        .sendCommand('Fetch.getResponseBody', { requestId })
        .then((body) => {
          const content = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf-8') : body.body;
          if (content.length === 0) return; // keep watching
          variantManifestText = content;
          console.log('variant manifest captured, length', content.length);
          fs.writeFileSync(path.join(app.getPath('desktop'), 'courtside_variant_debug.m3u8'), content);
        })
        .catch((e) => console.error('Fetch.getResponseBody failed:', e.message))
        .finally(() => {
          debug.sendCommand('Fetch.continueResponse', { requestId }).catch((e) => console.error('continueResponse failed:', e.message));
        });
    });
  } catch (e) {
    console.error('debugger attach failed:', e.message);
  }

  globalShortcut.register('CommandOrControl+Shift+P', async () => {
    try {
      const result = await paneView.webContents.executeJavaScript(`
        (() => {
          const knownNames = [
            'jwplayer', 'videojs', 'Hls', 'hls', 'shaka', 'bitmovin',
            'THEOplayer', 'dashjs', 'player', 'videoPlayer', 'akamaiPlayer',
            'conviva', 'nbaPlayer', 'ovp', 'OVP',
          ];
          let knownHits = [];
          try {
            knownHits = knownNames.filter((k) => {
              try { return k in window; } catch (e) { return false; }
            });
          } catch (e) {}

          const seekHits = [];
          try {
            for (const key of Object.getOwnPropertyNames(window)) {
              try {
                const val = window[key];
                if (val && typeof val === 'object' &&
                    (typeof val.seek === 'function' || typeof val.seekTo === 'function')) {
                  seekHits.push({
                    key,
                    hasSeek: typeof val.seek === 'function',
                    hasSeekTo: typeof val.seekTo === 'function',
                  });
                }
              } catch (e) { /* skip properties that throw on access */ }
            }
          } catch (e) {}

          let hasVideo = false;
          let videoOwnProps = [];
          try {
            const video = document.querySelector('video');
            hasVideo = !!video;
            if (video) {
              const nativeProps = new Set();
              let proto = Object.getPrototypeOf(video);
              while (proto) {
                Object.getOwnPropertyNames(proto).forEach((p) => nativeProps.add(p));
                proto = Object.getPrototypeOf(proto);
              }
              videoOwnProps = Object.getOwnPropertyNames(video).filter((k) => !nativeProps.has(k));
            }
          } catch (e) {}

          function looksLikePlayer(obj) {
            return obj && typeof obj === 'object' &&
              typeof obj.play === 'function' &&
              (typeof obj.seek === 'function' || typeof obj.seekTo === 'function');
          }
          const fiberHits = [];
          try {
            const video = document.querySelector('video');
            const fiberKey = video && Object.getOwnPropertyNames(video).find((k) => k.startsWith('__reactFiber$'));
            if (fiberKey) {
              let fiber = video[fiberKey];
              let depth = 0;
              while (fiber && depth < 25) {
                const candidates = { stateNode: fiber.stateNode, memoizedProps: fiber.memoizedProps, memoizedState: fiber.memoizedState };
                for (const [where, c] of Object.entries(candidates)) {
                  if (!c || typeof c !== 'object') continue;
                  if (looksLikePlayer(c)) fiberHits.push({ depth, where });
                  try {
                    for (const k of Object.keys(c)) {
                      if (looksLikePlayer(c[k])) fiberHits.push({ depth, where: where + '.' + k });
                    }
                  } catch (e) {}
                }
                fiber = fiber.return;
                depth++;
              }
            }
          } catch (e) {}

          return { knownHits, seekHits, hasVideo, videoOwnProps, fiberHits };
        })()
      `);
      console.log('player scan result:', JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('player scan failed:', err);
    }
  });

  globalShortcut.register('CommandOrControl+Shift+2', async () => {
    if (!variantManifestText) {
      console.log('skip-to-2nd-half: no manifest captured yet — is a game playing?');
      return;
    }
    const result = findSecondHalfStart(variantManifestText);
    if (!result) {
      console.log('skip-to-2nd-half: no discontinuities found in manifest');
      return;
    }
    console.log(
      `skip-to-2nd-half: seeking to ${result.target.toFixed(1)}s of ${result.total.toFixed(1)}s total ` +
        `(halftime gap was ${result.maxGap.toFixed(1)}s)`
    );
    try {
      const seekResult = await paneView.webContents.executeJavaScript(`
        (() => {
          function looksLikePlayer(obj) {
            return obj && typeof obj === 'object' &&
              typeof obj.play === 'function' &&
              (typeof obj.seek === 'function' || typeof obj.seekTo === 'function');
          }
          const video = document.querySelector('video');
          if (!video) return 'no video element found';
          const fiberKey = Object.getOwnPropertyNames(video).find((k) => k.startsWith('__reactFiber$'));
          if (!fiberKey) return 'no react fiber key on video element';
          let fiber = video[fiberKey];
          let depth = 0;
          while (fiber && depth < 25) {
            const stateNode = fiber.stateNode;
            if (looksLikePlayer(stateNode)) {
              if (typeof stateNode.seek === 'function') {
                stateNode.seek(${result.target});
                return 'called player.seek(${result.target}) at depth ' + depth;
              }
              stateNode.seekTo(${result.target});
              return 'called player.seekTo(${result.target}) at depth ' + depth;
            }
            if (stateNode && typeof stateNode === 'object') {
              for (const k of Object.keys(stateNode)) {
                if (looksLikePlayer(stateNode[k])) {
                  const p = stateNode[k];
                  if (typeof p.seek === 'function') {
                    p.seek(${result.target});
                    return 'called stateNode.' + k + '.seek(${result.target}) at depth ' + depth;
                  }
                  p.seekTo(${result.target});
                  return 'called stateNode.' + k + '.seekTo(${result.target}) at depth ' + depth;
                }
              }
            }
            fiber = fiber.return;
            depth++;
          }
          return 'no player instance found in fiber tree';
        })()
      `);
      console.log('skip-to-2nd-half:', seekResult);
    } catch (err) {
      console.error('skip-to-2nd-half: seek failed:', err);
    }
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
