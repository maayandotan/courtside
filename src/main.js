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

// Guesses which discontinuity marks the start of a given quarter (1-4),
// built on the insight validated for Q3 across 9 real games: gap SIZE is
// unreliable (halftime length varies wildly, a mid-quarter timeout can be
// longer than a "condensed" halftime), but stoppage COUNT is roughly
// symmetric, so the middle discontinuity by count lands near the true
// halftime transition. Q3 = floor(n/2) is validated. Q1/Q2/Q4 extend the
// same idea recursively (middle of the first/second half's own
// discontinuities) — UNVALIDATED until tested live against real games.
// Falls back to "closest to the expected time fraction" if a guess lands
// somewhere implausible for that quarter.
const QUARTER_EXPECTED_FRACTION = { 1: 0.05, 2: 0.3, 3: 0.5, 4: 0.72 };
const QUARTER_PLAUSIBLE_RANGE = {
  1: [0, 0.25],
  2: [0.15, 0.45],
  3: [0.3, 0.7],
  4: [0.55, 0.9],
};

function guessQuarterStartIndex(discontinuities, total, quarter) {
  const n = discontinuities.length;
  if (n === 0) return -1;

  const half = Math.floor(n / 2); // Q3 start
  let rawIndex;
  switch (quarter) {
    case 1:
      rawIndex = 0;
      break;
    case 2:
      rawIndex = Math.floor(half / 2);
      break;
    case 3:
      rawIndex = half;
      break;
    case 4:
      rawIndex = half + Math.floor((n - half) / 2);
      break;
    default:
      return -1;
  }
  rawIndex = Math.max(0, Math.min(n - 1, rawIndex));

  const [lowFraction, highFraction] = QUARTER_PLAUSIBLE_RANGE[quarter];
  const rawTime = discontinuities[rawIndex];
  let finalIndex = rawIndex;
  if (!(rawTime >= total * lowFraction && rawTime <= total * highFraction)) {
    let bestIndex = 0;
    let bestDiff = Infinity;
    discontinuities.forEach((d, i) => {
      const diff = Math.abs(d - total * QUARTER_EXPECTED_FRACTION[quarter]);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = i;
      }
    });
    finalIndex = bestIndex;
  }

  // REVERTED (2026-09-06): tried biasing Q2/Q4 one discontinuity earlier
  // here, since unlike Q3 (a guaranteed hard broadcast break — the
  // network always cuts to studio/ads exactly at halftime, reliable
  // across many games), Q1->Q2 and Q3->Q4 aren't guaranteed production
  // breaks, so the nearest discontinuity can land just after the true
  // boundary (confirmed live: 40s into an already-playing Q4 — a real
  // spoiler). But a flat -1 was too blunt: confirmed live on another
  // game, it jumped back into the WRONG quarter entirely (e.g. landed
  // late in Q1 for a Q2 guess). Discontinuity spacing near these two
  // boundaries is too uneven for any fixed index offset to work
  // reliably. Also tried anchoring off NBA's real play-by-play
  // wall-clock data instead (see the "TRIED AND ABANDONED" comment
  // below) — also confirmed broken, for an unrelated reason (VOD
  // trimming). Q2/Q4 remain a coarse hint requiring manual verification;
  // don't guess at another constant here.
  return finalIndex;
}

// TRIED AND ABANDONED (2026-09-06): anchoring Q2/Q4 off NBA's real
// play-by-play wall-clock timestamps (playbyplayv3's "Start of Nth
// Period (H:MM AM/PM TZ)" descriptions), computing VOD offsets via
// real-time deltas from the validated Q3 discontinuity anchor. Confirmed
// broken on real data: assumed real-world elapsed time between two
// period starts equals VOD elapsed time between them, but League Pass
// VODs are apparently trimmed/compressed relative to the live broadcast
// (some dead time removed), so a 50-real-minute gap corresponded to
// meaningfully less VOD time — landed still deep in the PRECEDING
// quarter, not at the target. This is a different, more fundamental
// failure than the stoppage-count heuristic's (which overshot into the
// target quarter) — not fixable by adjusting a safety margin. See
// README Phase 3 notes.

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
          'skip-to-quarter is not supported for this content (known v1 limitation, e.g. seen on a 2026 Finals game).'
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
                'skip-to-quarter not supported for this broadcast (known v1 limitation).'
            );
            return;
          }
          console.log(
            `variant manifest captured: ${discontinuities.length} discontinuities, total ${fmtTime(totalDuration)}. ` +
              'Press Cmd+Shift+1/2/3/4 to jump to a quarter start.'
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
  // Cmd+Shift+L: print the full discontinuity/gap table.
  // Cmd+Shift+1/2/3/4: jump to that quarter's guessed start.
  // Cmd+Shift+Right: step to the NEXT discontinuity and seek there.
  // Cmd+Shift+Left: step to the PREVIOUS discontinuity and seek there.
  // (Not Cmd+Shift+[/]: Cmd+Shift+[ silently did nothing in testing,
  // almost certainly colliding with macOS's own "previous Space"
  // Mission Control shortcut before it ever reached the app.)
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (!manifestCaptured) {
      console.log('calibrate: no manifest captured yet — is a game playing?');
      return;
    }
    if (discontinuities.length === 0) {
      console.log(
        'calibrate: this broadcast has no #EXT-X-DISCONTINUITY markers — ' +
          'skip-to-quarter is not supported for this content (known v1 limitation).'
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

  // Q3 lands reliably (validated across many real games — see README).
  // Q1 doesn't matter for spoiler safety (nothing to spoil pre-tip-off).
  // Q2/Q4 are a coarse hint only: two independent approaches (stoppage-
  // count symmetry, and NBA play-by-play wall-clock anchoring — see the
  // "TRIED AND ABANDONED" comment above) both failed for fundamental
  // reasons, not tunable bugs. Always verify with Cmd+Shift+Left/Right
  // before trusting a Q2/Q4 jump.
  [1, 2, 3, 4].forEach((quarter) => {
    globalShortcut.register(`CommandOrControl+Shift+${quarter}`, () => {
      if (!manifestCaptured || discontinuities.length === 0) {
        logCandidate(`Q${quarter} guess`);
        return;
      }
      candidateIndex = guessQuarterStartIndex(discontinuities, totalDuration, quarter);
      seekToCandidate(`Q${quarter} guess`);
    });
  });

  globalShortcut.register('CommandOrControl+Shift+Right', () => {
    candidateIndex = Math.min(candidateIndex + 1, discontinuities.length - 1);
    seekToCandidate('next');
  });
  globalShortcut.register('CommandOrControl+Shift+Left', () => {
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
