const fs = require('fs');
const path = require('path');
const { app, components, globalShortcut, ipcMain, BrowserWindow, WebContentsView } = require('electron');

const HEADER_HEIGHT = 56;
const LABEL_HEIGHT = 32;
const CONTROLS_HEIGHT = 32;
const PANE_HEADER_HEIGHT = LABEL_HEIGHT + CONTROLS_HEIGHT;
const PANE_MARGIN = 2;

// Parses an HLS media playlist into the VOD-timeline offset of every
// #EXT-X-DISCONTINUITY marker (broadcast structural boundaries — timeouts,
// period transitions), plus total runtime, plus whether this is a VOD
// (finished, #EXT-X-ENDLIST present) vs. a still-growing live playlist.
// Skip-to-quarter only makes sense for VOD — jumping to "Q3" on a live
// broadcast that hasn't reached Q3 yet is meaningless.
function parseDiscontinuities(manifestText) {
  const lines = manifestText.split('\n');
  let elapsed = 0;
  const discontinuities = [];
  let isVod = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF:')) {
      elapsed += parseFloat(line.slice('#EXTINF:'.length));
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuities.push(elapsed);
    } else if (line === '#EXT-X-ENDLIST' || line === '#EXT-X-PLAYLIST-TYPE:VOD') {
      isVod = true;
    }
  }
  return { discontinuities, total: elapsed, isVod };
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

// Encapsulates the skip-to-quarter feature's manifest-capture + seek
// state and logic for one pane. Only meaningful for services delivered
// as HLS with ad-stitch discontinuity markers (confirmed for League
// Pass) — not attached to panes where skipCapable is false.
function createSkipEngine(view, onManifestState) {
  const debug = view.webContents.debugger;
  const state = {
    manifestCaptured: false,
    discontinuities: [],
    totalDuration: 0,
    isVod: false,
    candidateIndex: -1,
    attempts: 0,
  };
  const MAX_ATTEMPTS = 30;
  const notify = onManifestState || (() => {});

  const logCandidate = (label) => {
    if (!state.manifestCaptured) {
      console.log('calibrate: no manifest captured yet — is a game playing?');
      return;
    }
    if (state.discontinuities.length === 0) {
      console.log(
        'calibrate: this broadcast has no #EXT-X-DISCONTINUITY markers — ' +
          'skip-to-quarter is not supported for this content (known v1 limitation, e.g. seen on a 2026 Finals game).'
      );
      return;
    }
    if (state.candidateIndex < 0 || state.candidateIndex >= state.discontinuities.length) {
      console.log(`calibrate: index ${state.candidateIndex} out of range (0..${state.discontinuities.length - 1})`);
      return;
    }
    const t = state.discontinuities[state.candidateIndex];
    const prev = state.candidateIndex > 0 ? state.discontinuities[state.candidateIndex - 1] : 0;
    console.log(
      `calibrate: [${label}] index ${state.candidateIndex}/${state.discontinuities.length - 1}, ` +
        `time ${fmtTime(t)} (${t.toFixed(1)}s), gap-before ${(t - prev).toFixed(1)}s`
    );
  };

  const seekToCandidate = async (label) => {
    logCandidate(label);
    if (!state.manifestCaptured || state.discontinuities.length === 0) return;
    if (state.candidateIndex < 0 || state.candidateIndex >= state.discontinuities.length) return;
    try {
      const seekResult = await view.webContents.executeJavaScript(SEEK_SCRIPT(state.discontinuities[state.candidateIndex]));
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

      if (state.manifestCaptured || isMaster || state.attempts >= MAX_ATTEMPTS) {
        debug.sendCommand('Fetch.continueResponse', { requestId }).catch(() => {});
        if (state.manifestCaptured) debug.sendCommand('Fetch.disable').catch(() => {});
        return;
      }

      if (responseStatusCode >= 300 && responseStatusCode < 400) {
        // Redirect leg (e.g. CDN token issuance hop) — no content here.
        debug.sendCommand('Fetch.continueResponse', { requestId }).catch(() => {});
        return;
      }

      state.attempts += 1;
      debug
        .sendCommand('Fetch.getResponseBody', { requestId })
        .then((body) => {
          const content = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf-8') : body.body;
          if (content.length === 0) return; // keep watching
          const parsed = parseDiscontinuities(content);
          state.discontinuities = parsed.discontinuities;
          state.totalDuration = parsed.total;
          state.isVod = parsed.isVod;
          state.manifestCaptured = true;

          if (!state.isVod) {
            console.log('variant manifest captured: still live (no #EXT-X-ENDLIST) — skip-to-quarter not available yet.');
            notify({ ready: false, reason: 'Not available for a live game.' });
            return;
          }
          if (state.discontinuities.length === 0) {
            console.log(
              `variant manifest captured: total ${fmtTime(state.totalDuration)}, 0 discontinuities — ` +
                'skip-to-quarter not supported for this broadcast (known v1 limitation).'
            );
            notify({ ready: false, reason: 'Not supported for this broadcast.' });
            return;
          }
          console.log(
            `variant manifest captured: ${state.discontinuities.length} discontinuities, total ${fmtTime(state.totalDuration)}. ` +
              'Press Cmd+Shift+1/2/3/4 to jump to a quarter start.'
          );
          notify({ ready: true });
        })
        .catch((e) => console.error('Fetch.getResponseBody failed:', e.message))
        .finally(() => {
          debug.sendCommand('Fetch.continueResponse', { requestId }).catch((e) => console.error('continueResponse failed:', e.message));
        });
    });
  } catch (e) {
    console.error('debugger attach failed:', e.message);
  }

  return {
    dumpTable() {
      if (!state.manifestCaptured) {
        console.log('calibrate: no manifest captured yet — is a game playing?');
        return;
      }
      if (state.discontinuities.length === 0) {
        console.log(
          'calibrate: this broadcast has no #EXT-X-DISCONTINUITY markers — ' +
            'skip-to-quarter is not supported for this content (known v1 limitation).'
        );
        return;
      }
      console.log(`calibrate: ${state.discontinuities.length} discontinuities, total ${fmtTime(state.totalDuration)}`);
      let prev = 0;
      state.discontinuities.forEach((d, i) => {
        console.log(`  #${i}: ${fmtTime(d)} (${d.toFixed(1)}s)  gap-before ${(d - prev).toFixed(1)}s`);
        prev = d;
      });
    },
    jumpToQuarter(quarter) {
      if (!state.manifestCaptured || state.discontinuities.length === 0) {
        logCandidate(`Q${quarter} guess`);
        return;
      }
      state.candidateIndex = guessQuarterStartIndex(state.discontinuities, state.totalDuration, quarter);
      seekToCandidate(`Q${quarter} guess`);
    },
    stepNext() {
      state.candidateIndex = Math.min(state.candidateIndex + 1, state.discontinuities.length - 1);
      seekToCandidate('next');
    },
    stepPrev() {
      state.candidateIndex = Math.max(state.candidateIndex - 1, 0);
      seekToCandidate('prev');
    },
  };
}

// Lays out every pane in an equal-width row (2-up for now; extending to a
// 2x2 4-up grid later is just changing `cols`). Not-yet-ready panes are
// collapsed to zero size so the shell's own loading/error UI shows
// through instead of a blank native view.
// `splitRatio` (0.2-0.8) controls how much of the total width the first
// pane gets when there are exactly 2 panes in a single row — dragging
// the divider in the renderer updates this live via the
// 'set-split-ratio' IPC channel. With more than 2 panes (future 4-up
// grid) this falls back to equal division; a per-row/column ratio
// system for that case doesn't exist yet.
function layoutPanes(win, panes, splitRatio) {
  const { width, height } = win.getContentBounds();
  const n = panes.length;
  const cols = n <= 1 ? 1 : 2;
  const rows = Math.ceil(n / cols);
  const cellHeight = (height - HEADER_HEIGHT) / rows;
  const useRatio = n === 2 && typeof splitRatio === 'number';

  panes.forEach((pane, i) => {
    if (!pane.ready) {
      pane.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const col = i % cols;
    const row = Math.floor(i / cols);
    let cellX;
    let cellWidth;
    if (useRatio) {
      const firstWidth = width * splitRatio;
      cellX = col === 0 ? 0 : firstWidth;
      cellWidth = col === 0 ? firstWidth : width - firstWidth;
    } else {
      cellWidth = width / cols;
      cellX = col * cellWidth;
    }
    const x = cellX + PANE_MARGIN;
    const y = HEADER_HEIGHT + row * cellHeight + PANE_HEADER_HEIGHT + PANE_MARGIN;
    const w = cellWidth - PANE_MARGIN * 2;
    const h = cellHeight - PANE_HEADER_HEIGHT - PANE_MARGIN * 2;
    pane.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(0, Math.round(w)),
      height: Math.max(0, Math.round(h)),
    });
  });
}

function createPane(win, index, { url, skipCapable }, layoutAll) {
  const view = new WebContentsView();
  win.contentView.addChildView(view);

  const pane = {
    index,
    url,
    view,
    ready: false,
    skip: skipCapable
      ? createSkipEngine(view, (manifestState) => {
          win.webContents.send('pane-skip-state', { index, ...manifestState });
        })
      : null,
  };

  const sendStatus = (status) => win.webContents.send('pane-status', { index, ...status });

  view.webContents.on('did-start-loading', () => sendStatus({ state: 'loading' }));
  view.webContents.on('did-finish-load', () => {
    pane.ready = true;
    sendStatus({ state: 'ready' });
    layoutAll();
  });
  view.webContents.on('did-fail-load', (_event, _code, description) => {
    pane.ready = false;
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    sendStatus({ state: 'error', message: description || 'Stream failed to load.' });
  });

  view.webContents.loadURL(url);
  return pane;
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

  // Second pane is YouTube as a placeholder — testing the grid/focus
  // mechanics while between real second-service subscriptions (Yes
  // STING -> Hot Next TV). Swap in the real second service once that
  // subscription is active; the grid/focus code itself doesn't care
  // what's in a pane.
  const paneConfigs = [
    { url: 'https://www.nba.com/watch', label: 'League Pass', skipCapable: true },
    { url: 'https://www.dazn.com', label: 'DAZN (test)', skipCapable: false },
  ];

  let splitRatio = 0.5;
  const panes = [];
  const layoutAll = () => layoutPanes(win, panes, splitRatio);
  paneConfigs.forEach((cfg, index) => {
    panes.push(createPane(win, index, cfg, layoutAll));
  });

  let focusedIndex = 0;
  const setFocus = (index) => {
    if (index < 0 || index >= panes.length) return;
    focusedIndex = index;
    panes.forEach((pane, i) => pane.view.webContents.setAudioMuted(i !== index));
    win.webContents.send('focus-changed', { index });
  };

  win.webContents.on('did-finish-load', () => {
    win.webContents.send(
      'panes-config',
      paneConfigs.map((cfg, index) => ({ index, label: cfg.label, skipCapable: cfg.skipCapable }))
    );
    setFocus(0);
  });

  ipcMain.on('focus-pane', (_event, index) => setFocus(index));
  ipcMain.on('retry-pane', (_event, index) => {
    const pane = panes[index];
    if (!pane) return;
    pane.ready = false;
    pane.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    win.webContents.send('pane-status', { index, state: 'loading' });
    pane.view.webContents.reload();
  });
  ipcMain.on('jump-to-quarter', (_event, { index, quarter }) => {
    const pane = panes[index];
    if (pane && pane.skip) pane.skip.jumpToQuarter(quarter);
  });
  ipcMain.on('nudge-quarter', (_event, { index, direction }) => {
    const pane = panes[index];
    if (!pane || !pane.skip) return;
    if (direction === 'next') pane.skip.stepNext();
    else pane.skip.stepPrev();
  });
  ipcMain.on('set-split-ratio', (_event, ratio) => {
    splitRatio = Math.max(0.2, Math.min(0.8, ratio));
    layoutAll();
  });

  win.on('resize', layoutAll);

  // --- Calibration hotkeys (operate on the currently FOCUSED pane) ---
  // Cmd+Shift+L: print the full discontinuity/gap table.
  // Cmd+Shift+1/2/3/4: jump to that quarter's guessed start.
  // Cmd+Shift+Right: step to the NEXT discontinuity and seek there.
  // Cmd+Shift+Left: step to the PREVIOUS discontinuity and seek there.
  // (Not Cmd+Shift+[/]: Cmd+Shift+[ silently did nothing in testing,
  // almost certainly colliding with macOS's own "previous Space"
  // Mission Control shortcut before it ever reached the app.)
  const focusedSkip = () => {
    const pane = panes[focusedIndex];
    if (!pane || !pane.skip) {
      console.log(`pane ${focusedIndex} doesn't support skip-to-quarter (not an HLS/manifest-based service).`);
      return null;
    }
    return pane.skip;
  };

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    const skip = focusedSkip();
    if (skip) skip.dumpTable();
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
      const skip = focusedSkip();
      if (skip) skip.jumpToQuarter(quarter);
    });
  });

  globalShortcut.register('CommandOrControl+Shift+Right', () => {
    const skip = focusedSkip();
    if (skip) skip.stepNext();
  });
  globalShortcut.register('CommandOrControl+Shift+Left', () => {
    const skip = focusedSkip();
    if (skip) skip.stepPrev();
  });
}

app.whenReady().then(async () => {
  await components.whenReady();
  console.log('Widevine component status:', components.status());
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
