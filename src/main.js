const fs = require('fs');
const path = require('path');
const { app, components, globalShortcut, ipcMain, BrowserWindow, WebContentsView } = require('electron');

const HEADER_HEIGHT = 56;
const PANE_MARGIN = 2;

// Parses an HLS media playlist into the VOD-timeline offset of every
// #EXT-X-DISCONTINUITY marker (broadcast structural boundaries — timeouts,
// period transitions), plus total runtime.
function parseDiscontinuities(manifestText) {
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
  return { discontinuities, total: elapsed };
}

// Initial guess for "start of 2nd half": the middle discontinuity by
// COUNT, not by gap size. Gap-size ranking is unreliable — a mid-quarter
// timeout can be longer than a "condensed" halftime break — but
// stoppage counts are roughly symmetric across a game, so the middle
// discontinuity index tends to land near the actual halftime transition.
// Confirmed exactly correct against one real game (index 6 of 12); if the
// middle-by-count candidate looks implausible (outside 25%-75% of total
// runtime), fall back to whichever discontinuity is closest to the
// literal time midpoint. Cmd+Shift+[ / Cmd+Shift+] exist to correct this
// guess interactively when it's off by one.
function guessSecondHalfIndex(discontinuities, total) {
  if (discontinuities.length === 0) return -1;
  const middleIndex = Math.floor(discontinuities.length / 2);
  const middleTime = discontinuities[middleIndex];
  if (middleTime >= total * 0.25 && middleTime <= total * 0.75) {
    return middleIndex;
  }
  let bestIndex = 0;
  let bestDiff = Infinity;
  discontinuities.forEach((d, i) => {
    const diff = Math.abs(d - total / 2);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  });
  return bestIndex;
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// Finds the live player instance by walking up the video element's React
// fiber tree looking for an object exposing .play() + .seek()/.seekTo()
// (works for Bitmovin Player; generic enough to survive minor changes),
// then calls it. Raw video.currentTime mutation stalls this player
// indefinitely, so this is the only reliable seek path found so far.
const SEEK_SCRIPT = (targetSeconds) => `
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
          stateNode.seek(${targetSeconds});
          return 'called player.seek(${targetSeconds}) at depth ' + depth;
        }
        stateNode.seekTo(${targetSeconds});
        return 'called player.seekTo(${targetSeconds}) at depth ' + depth;
      }
      if (stateNode && typeof stateNode === 'object') {
        for (const k of Object.keys(stateNode)) {
          if (looksLikePlayer(stateNode[k])) {
            const p = stateNode[k];
            if (typeof p.seek === 'function') {
              p.seek(${targetSeconds});
              return 'called stateNode.' + k + '.seek(${targetSeconds}) at depth ' + depth;
            }
            p.seekTo(${targetSeconds});
            return 'called stateNode.' + k + '.seekTo(${targetSeconds}) at depth ' + depth;
          }
        }
      }
      fiber = fiber.return;
      depth++;
    }
    return 'no player instance found in fiber tree';
  })()
`;

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
  let manifestCaptured = false;
  let discontinuities = [];
  let totalDuration = 0;
  let candidateIndex = -1;
  let attempts = 0;
  const MAX_ATTEMPTS = 30;

  const logCandidate = (label) => {
    if (!manifestCaptured) {
      console.log('calibrate: no manifest captured yet — is a game playing?');
      return;
    }
    if (discontinuities.length === 0) {
      console.log(
        'calibrate: this broadcast has no #EXT-X-DISCONTINUITY markers — ' +
          'skip-to-2nd-half is not supported for this content (known v1 limitation, e.g. seen on a 2026 Finals game).'
      );
      return;
    }
    if (candidateIndex < 0 || candidateIndex >= discontinuities.length) {
      console.log(`calibrate: index ${candidateIndex} out of range (0..${discontinuities.length - 1})`);
      return;
    }
    const t = discontinuities[candidateIndex];
    const prev = candidateIndex > 0 ? discontinuities[candidateIndex - 1] : 0;
    console.log(
      `calibrate: [${label}] index ${candidateIndex}/${discontinuities.length - 1}, ` +
        `time ${fmtTime(t)} (${t.toFixed(1)}s), gap-before ${(t - prev).toFixed(1)}s`
    );
  };

  const seekToCandidate = async (label) => {
    logCandidate(label);
    if (!manifestCaptured || discontinuities.length === 0) return;
    if (candidateIndex < 0 || candidateIndex >= discontinuities.length) return;
    try {
      const seekResult = await paneView.webContents.executeJavaScript(SEEK_SCRIPT(discontinuities[candidateIndex]));
      console.log('calibrate: seek result:', seekResult);
    } catch (err) {
      console.error('calibrate: seek failed:', err);
    }
  };

  try {
    debug.attach('1.3');
    debug
      .sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*.m3u8*', requestStage: 'Response' }] })
      .catch((e) => console.error('Fetch.enable failed:', e.message));
    debug.on('message', (_event, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const { requestId, request, responseStatusCode } = params;
      const isMaster = /\/index\.m3u8/i.test(request.url);

      if (manifestCaptured || isMaster || attempts >= MAX_ATTEMPTS) {
        debug.sendCommand('Fetch.continueResponse', { requestId }).catch(() => {});
        if (manifestCaptured) debug.sendCommand('Fetch.disable').catch(() => {});
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
          fs.writeFileSync(path.join(app.getPath('desktop'), 'courtside_variant_debug.m3u8'), content);
          const parsed = parseDiscontinuities(content);
          discontinuities = parsed.discontinuities;
          totalDuration = parsed.total;
          manifestCaptured = true;
          if (discontinuities.length === 0) {
            console.log(
              `variant manifest captured: total ${fmtTime(totalDuration)}, 0 discontinuities — ` +
                'skip-to-2nd-half not supported for this broadcast (known v1 limitation).'
            );
            return;
          }
          candidateIndex = guessSecondHalfIndex(discontinuities, totalDuration);
          console.log(
            `variant manifest captured: ${discontinuities.length} discontinuities, ` +
              `total ${fmtTime(totalDuration)}. Initial guess: index ${candidateIndex}.`
          );
        })
        .catch((e) => console.error('Fetch.getResponseBody failed:', e.message))
        .finally(() => {
          debug.sendCommand('Fetch.continueResponse', { requestId }).catch((e) => console.error('continueResponse failed:', e.message));
        });
    });
  } catch (e) {
    console.error('debugger attach failed:', e.message);
  }

  // --- Calibration hotkeys ---
  // Cmd+Shift+3: print the full discontinuity/gap table.
  // Cmd+Shift+2: seek to the current best-guess candidate.
  // Cmd+Shift+]: step to the NEXT discontinuity and seek there.
  // Cmd+Shift+[: step to the PREVIOUS discontinuity and seek there.
  globalShortcut.register('CommandOrControl+Shift+3', () => {
    if (!manifestCaptured) {
      console.log('calibrate: no manifest captured yet — is a game playing?');
      return;
    }
    if (discontinuities.length === 0) {
      console.log(
        'calibrate: this broadcast has no #EXT-X-DISCONTINUITY markers — ' +
          'skip-to-2nd-half is not supported for this content (known v1 limitation).'
      );
      return;
    }
    console.log(`calibrate: ${discontinuities.length} discontinuities, total ${fmtTime(totalDuration)}`);
    let prev = 0;
    discontinuities.forEach((d, i) => {
      console.log(`  #${i}: ${fmtTime(d)} (${d.toFixed(1)}s)  gap-before ${(d - prev).toFixed(1)}s`);
      prev = d;
    });
  });

  globalShortcut.register('CommandOrControl+Shift+2', () => seekToCandidate('guess'));
  globalShortcut.register('CommandOrControl+Shift+]', () => {
    candidateIndex = Math.min(candidateIndex + 1, discontinuities.length - 1);
    seekToCandidate('next');
  });
  globalShortcut.register('CommandOrControl+Shift+[', () => {
    candidateIndex = Math.max(candidateIndex - 1, 0);
    seekToCandidate('prev');
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
