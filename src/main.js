const fs = require('fs');
const path = require('path');
const { app, components, globalShortcut, ipcMain, BrowserWindow, WebContentsView } = require('electron');

const HEADER_HEIGHT = 56;
const LABEL_HEIGHT = 32;
const CONTROLS_HEIGHT = 32;
const PANE_HEADER_HEIGHT = LABEL_HEIGHT + CONTROLS_HEIGHT;
const PANE_MARGIN = 2;

// Text to search for with the Cmd+Shift+D DOM-scan hotkey (see its
// registration below) — edit and rebuild per investigation.
const DOM_SCAN_QUERY = 'Sep';

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
    // The last row may have fewer panes than `cols` (e.g. 3 panes: row 0
    // has 2, row 1 has 1) — give that lone pane the row's full width
    // instead of leaving a blank gap next to it.
    const colsInRow = Math.min(cols, n - row * cols);
    let cellX;
    let cellWidth;
    if (useRatio) {
      const firstWidth = width * splitRatio;
      cellX = col === 0 ? 0 : firstWidth;
      cellWidth = col === 0 ? firstWidth : width - firstWidth;
    } else {
      cellWidth = width / colsInRow;
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

// If a URL is a shortened YouTube link (youtu.be/{id}), normalizes it
// to the standard watch page. YouTube's dedicated embed player
// (youtube.com/embed/{id}) rejects top-level/data: URL navigation with
// error 153 (it expects a real hosted-page origin genuinely embedding
// it in an <iframe>) — not worth fighting. Spoiler-relevant chrome
// (title, comments, related-video thumbnails) on the normal watch page
// is instead hidden via CSS injection once it loads — see
// YOUTUBE_SPOILER_HIDE_CSS below.
function normalizeYouTubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'youtu.be') {
      const videoId = u.pathname.slice(1);
      return `https://www.youtube.com/watch?v=${videoId}&autoplay=1`;
    }
  } catch (e) {
    // not a valid URL — fall through
  }
  return rawUrl;
}

// Hides YouTube watch-page chrome that could reveal a score/result
// before a highlight is actually watched: the title, description,
// comments, and the related/"up next" sidebar (often full of
// spoiler-laden thumbnails and text for the same match).
const YOUTUBE_SPOILER_HIDE_CSS = `
  #related, #comments, #title, ytd-watch-metadata,
  ytd-comments, #meta-contents, ytd-masthead {
    display: none !important;
  }
`;

// Hides thumbnails and titles on a YouTube search-within-channel
// results page — official highlight video titles almost always contain
// the final score ("Arsenal 2-1 Chelsea | Highlights"), so this is not
// optional the way it might be elsewhere. Uses visibility (not
// display:none) so result rows keep their normal size/position and
// stay clickable, even though their content isn't visible.
const YOUTUBE_SEARCH_HIDE_CSS = `
  ytd-thumbnail, #video-title, ytd-video-meta-block,
  .metadata-snippet-container, ytd-masthead {
    visibility: hidden !important;
  }
`;

function isYouTubeSearchPage(urlString) {
  try {
    const u = new URL(urlString);
    return /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname.endsWith('/search');
  } catch (e) {
    return false;
  }
}

// A fresh loadURL() straight to /@handle/search?query=X was confirmed
// (live, via manual testing) to render as a plain channel page, not
// search results — YouTube's SPA only runs the search route on a real
// client-side navigation, not a top-level load. So instead we load the
// plain channel page and then drive the real masthead search box
// ourselves: set its value via the native input setter (bypasses
// React's controlled-input tracking, which a plain .value= assignment
// doesn't trigger), fire an input event so YouTube's own JS notices,
// then click the actual submit button — mimicking a genuine user
// search rather than navigating to a URL directly.
const EPL_SEARCH_SCRIPT = (query) => `
  (async () => {
    const input = document.querySelector('input.ytSearchboxComponentInput');
    const button = document.querySelector('button.ytSearchboxComponentSearchButton');
    if (!input || !button) return { ok: false, reason: 'search box not found' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    button.click();

    // Results render via client-side routing (no full page load), so
    // poll the DOM instead of waiting on a navigation event.
    // ytd-video-renderer is a normal search-result row; sponsored/ad
    // slots use other element types, so this naturally skips them and
    // lands on the first genuine result.
    const deadline = Date.now() + 6000;
    let firstResultLink = null;
    while (Date.now() < deadline && !firstResultLink) {
      const firstRow = document.querySelector('ytd-video-renderer');
      firstResultLink = firstRow && firstRow.querySelector('a#video-title, a#thumbnail');
      if (!firstResultLink) await new Promise((r) => setTimeout(r, 200));
    }
    if (!firstResultLink) return { ok: false, reason: 'no search results found' };
    firstResultLink.click();
    return { ok: true };
  })()
`;

// UEFA's fixtures page (uefa.com/uefachampionsleague/fixtures-results/
// #/d/{date}) has no per-match URL — everything for a given date lives
// on one page, with a small highlights thumbnail on each match card
// (only visible once logged into a UEFA account; a free account is
// enough, but this app never touches those credentials — the user logs
// in manually within the pane, same as DAZN/League Pass elsewhere in
// this app). Rather than a text search box like YouTube, this finds
// the specific match by looking for the smallest DOM element whose
// text contains BOTH team names (the match card itself, not some huge
// ancestor container also matching by coincidence), then clicks the
// first plausible interactive element inside it — expected to be the
// highlights thumbnail, but not yet confirmed against the real
// logged-in DOM (best-effort first pass, refine live if it clicks the
// wrong thing).
// Confirmed live (2026-09-09): a cold loadURL() straight to
// #/d/{date} does NOT reliably render that date's match cards, even
// waiting several seconds — but clicking the on-page date tab for the
// same date (a real in-app navigation, exactly like YouTube's search
// needing a real interaction rather than a raw URL) does. So this
// clicks the date tab itself before looking for the match, rather
// than trusting the hash alone. Match ids ARE contiguous within a
// single date's block (confirmed: three known Sept-8 matches came
// back 2049555/2049556/2049557, and the full block for that date was
// 2049553-2049558) but with no known formula for a block's starting
// id — visiting the fixtures page and clicking through is still the
// only reliable route to a specific match, not URL construction.
// UEFA's site is built on Stencil web components (confirmed via its
// own JS bundle names) — the date-tab strip and match cards live
// inside shadow roots, which plain document.querySelectorAll/
// textContent completely miss (they don't pierce shadow boundaries at
// all). This is why the first two attempts found nothing: the search
// itself was blind to most of the page, not just slow. deepQueryAll
// walks light DOM AND every nested shadow root to build one real
// element list to search over.
const CL_HIGHLIGHT_SCRIPT = (homeName, awayName) => `
  (async () => {
    function collectWithShadow(root, out) {
      root.querySelectorAll('*').forEach((el) => {
        out.push(el);
        if (el.shadowRoot) collectWithShadow(el.shadowRoot, out);
      });
    }

    // Finds the smallest element whose deep text (light DOM + all
    // nested shadow roots — plain textContent sees neither on this
    // Stencil-built site) contains both team names. Memoized bottom-up
    // per call so each element's text is computed once and reused by
    // its ancestors — the earlier version recomputed a fresh deep-text
    // walk for every one of thousands of elements on every comparison
    // (effectively O(n^2)), which on a page this heavy likely never
    // finished a single pass inside the retry loop at all — a much
    // simpler explanation for "takes forever" than anything about the
    // site itself.
    function findSmallestMatch() {
      const all = [];
      collectWithShadow(document, all);
      const cache = new WeakMap();
      function ownText(el) {
        if (cache.has(el)) return cache.get(el);
        let text = '';
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) text += n.textContent;
          else if (n.nodeType === Node.ELEMENT_NODE) text += ownText(n);
        });
        if (el.shadowRoot) text += ownText(el.shadowRoot);
        cache.set(el, text);
        return text;
      }
      let best = null;
      let bestLen = Infinity;
      for (const el of all) {
        const text = ownText(el);
        if (text.length < bestLen && text.includes(${JSON.stringify(homeName)}) && text.includes(${JSON.stringify(awayName)})) {
          best = el;
          bestLen = text.length;
        }
      }
      return best;
    }

    const deadline = Date.now() + 15000;
    let matchEl = null;
    while (Date.now() < deadline && !matchEl) {
      matchEl = findSmallestMatch();
      if (!matchEl) await new Promise((r) => setTimeout(r, 500));
    }
    if (!matchEl) return { ok: false, reason: 'match card not found', searchedFor: [${JSON.stringify(homeName)}, ${JSON.stringify(awayName)}] };
    const clickable = [];
    collectWithShadow(matchEl, clickable);
    const target = clickable.find((el) => ['BUTTON', 'A', 'VIDEO', 'IMG'].includes(el.tagName) || el.getAttribute('role') === 'button') || matchEl;
    target.click();
    return { ok: true };
  })()
`;

function createPane(win, id, { url, skipCapable, label, league }, layoutAll) {
  const view = new WebContentsView();
  win.contentView.addChildView(view);

  const pane = {
    id,
    url,
    label: label || '',
    league: league || null,
    view,
    ready: false,
    // Set while a scripted multi-step navigation (e.g. the EPL
    // highlights channel search) is in progress, so intermediate pages
    // (the channel page, the search results) stay hidden instead of
    // flashing on screen before the final destination loads.
    autoNavigating: false,
    skip: skipCapable
      ? createSkipEngine(view, (manifestState) => {
          win.webContents.send('pane-skip-state', { id, ...manifestState });
        })
      : null,
  };

  const sendStatus = (status) => win.webContents.send('pane-status', { id, ...status });

  // Some sites (e.g. Premier League's highlights, which redirect to
  // YouTube) use window.open()/target=_blank instead of a normal same-
  // page navigation. Left alone, Electron spawns an untracked native
  // window outside the whole pane/grid model. Deny the popup and
  // navigate this same pane instead — keeps everything inside the
  // shell, matching "indistinguishable from a normal browser tab" for
  // the parts of the architecture we actually control.
  view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const finalUrl = normalizeYouTubeUrl(targetUrl);
    console.log(`pane ${id}: intercepted popup, navigating in-place to`, finalUrl);
    view.webContents.loadURL(finalUrl);
    return { action: 'deny' };
  });

  // YouTube's own navigation (channel -> search -> watch, driven by our
  // scripted search) is all client-side routing, not full page loads —
  // did-finish-load only fires once, for the initial channel page. Hook
  // did-navigate-in-page too so spoiler-hiding CSS gets reapplied at
  // each SPA route change.
  const applyYouTubeSpoilerCss = (currentUrl) => {
    try {
      const hostname = new URL(currentUrl).hostname;
      if (!/(^|\.)youtube\.com$/.test(hostname)) return;
      const css = isYouTubeSearchPage(currentUrl) ? YOUTUBE_SEARCH_HIDE_CSS : YOUTUBE_SPOILER_HIDE_CSS;
      view.webContents.insertCSS(css).catch(() => {});
    } catch (e) {
      // not a valid URL yet — ignore
    }
  };

  view.webContents.on('did-start-loading', () => sendStatus({ state: 'loading' }));
  view.webContents.on('did-navigate-in-page', () => {
    const currentUrl = view.webContents.getURL();
    console.log(`pane ${id}: did-navigate-in-page, url is now`, currentUrl);
    applyYouTubeSpoilerCss(currentUrl);
  });
  view.webContents.on('did-finish-load', () => {
    const currentUrl = view.webContents.getURL();
    console.log(`pane ${id}: did-finish-load, url is now`, currentUrl);
    applyYouTubeSpoilerCss(currentUrl);
    // While a scripted navigation is in flight, keep the pane hidden
    // (ready stays false, so layoutPanes collapses it to 0x0) rather
    // than revealing each intermediate page as it loads.
    if (pane.autoNavigating) return;
    pane.ready = true;
    sendStatus({ state: 'ready' });
    layoutAll();
  });
  view.webContents.on('did-fail-load', (_event, errorCode, description, validatedUrl, isMainFrame) => {
    console.log(`pane ${id}: did-fail-load`, { errorCode, description, validatedUrl, isMainFrame });
    // -3 is ERR_ABORTED — Chromium fires this constantly for a load
    // that got superseded by another navigation (completely normal
    // mid-redirect-chain, e.g. an OAuth login bounce through 2-3
    // domains), not a real failure. Treating it as fatal was surfacing
    // a false "Stream failed to load" error mid-flight during scripted
    // navigations that redirect through a login page (Champions
    // League's UEFA.tv auth flow does this) — the eventual real
    // did-finish-load was still coming.
    if (errorCode === -3) return;
    if (!isMainFrame) return;
    pane.ready = false;
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    sendStatus({ state: 'error', message: description || 'Stream failed to load.' });
  });

  if (url) view.webContents.loadURL(url);
  return pane;
}

const NBA_TEAMS = [
  { tricode: 'ATL', name: 'Atlanta Hawks' },
  { tricode: 'BOS', name: 'Boston Celtics' },
  { tricode: 'BKN', name: 'Brooklyn Nets' },
  { tricode: 'CHA', name: 'Charlotte Hornets' },
  { tricode: 'CHI', name: 'Chicago Bulls' },
  { tricode: 'CLE', name: 'Cleveland Cavaliers' },
  { tricode: 'DAL', name: 'Dallas Mavericks' },
  { tricode: 'DEN', name: 'Denver Nuggets' },
  { tricode: 'DET', name: 'Detroit Pistons' },
  { tricode: 'GSW', name: 'Golden State Warriors' },
  { tricode: 'HOU', name: 'Houston Rockets' },
  { tricode: 'IND', name: 'Indiana Pacers' },
  { tricode: 'LAC', name: 'LA Clippers' },
  { tricode: 'LAL', name: 'Los Angeles Lakers' },
  { tricode: 'MEM', name: 'Memphis Grizzlies' },
  { tricode: 'MIA', name: 'Miami Heat' },
  { tricode: 'MIL', name: 'Milwaukee Bucks' },
  { tricode: 'MIN', name: 'Minnesota Timberwolves' },
  { tricode: 'NOP', name: 'New Orleans Pelicans' },
  { tricode: 'NYK', name: 'New York Knicks' },
  { tricode: 'OKC', name: 'Oklahoma City Thunder' },
  { tricode: 'ORL', name: 'Orlando Magic' },
  { tricode: 'PHI', name: 'Philadelphia 76ers' },
  { tricode: 'PHX', name: 'Phoenix Suns' },
  { tricode: 'POR', name: 'Portland Trail Blazers' },
  { tricode: 'SAC', name: 'Sacramento Kings' },
  { tricode: 'SAS', name: 'San Antonio Spurs' },
  { tricode: 'TOR', name: 'Toronto Raptors' },
  { tricode: 'UTA', name: 'Utah Jazz' },
  { tricode: 'WAS', name: 'Washington Wizards' },
];

const PREFS_PATH = path.join(app.getPath('userData'), 'preferences.json');

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveFavoriteTeam(tricode) {
  const prefs = loadPrefs();
  prefs.favoriteTeam = tricode;
  fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
}

// Runs a fetch from inside a real page (not the main process) — the
// only reliable way to reach some NBA-adjacent hosts. Main-process
// fetch() silently hangs against stats.nba.com (likely a TLS/HTTP
// fingerprint mismatch triggering anti-bot filtering); page-context
// fetch uses Chromium's real network stack and works. See README.
async function fetchViaPage(view, url, extraHeaders) {
  return view.webContents.executeJavaScript(`
    Promise.race([
      fetch(${JSON.stringify(url)}, { headers: ${JSON.stringify(extraHeaders || {})} }).then((r) => r.text()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 10s')), 10000)),
    ])
  `);
}

const STATS_HEADERS = { 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true', Accept: 'application/json' };

// Home page data: today's games if any exist, otherwise the last
// completed game from the most recently finished season (currently
// hardcoded to the 2025-26 season — will need updating once a new
// season is underway, see README known gaps).
async function getHomeData(view) {
  try {
    const text = await fetchViaPage(view, 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json');
    const games = JSON.parse(text)?.scoreboard?.games || [];
    if (games.length > 0) {
      return {
        heading: "Today's Games",
        games: games.map((g) => ({
          gameId: g.gameId,
          awayTricode: g.awayTeam.teamTricode,
          homeTricode: g.homeTeam.teamTricode,
          awayName: g.awayTeam.teamName,
          homeName: g.homeTeam.teamName,
          status: g.gameStatusText,
        })),
      };
    }
  } catch (e) {
    console.error('getHomeData: today fetch failed:', e.message);
  }

  try {
    const text = await fetchViaPage(
      view,
      'https://stats.nba.com/stats/leaguegamefinder?LeagueID=00&Season=2025-26&SeasonType=Playoffs&PlayerOrTeam=T',
      STATS_HEADERS
    );
    const rs = JSON.parse(text).resultSets[0];
    const idx = (name) => rs.headers.indexOf(name);
    const rows = rs.rowSet;
    if (rows.length > 0) {
      const lastDate = rows.reduce((max, r) => (r[idx('GAME_DATE')] > max ? r[idx('GAME_DATE')] : max), rows[0][idx('GAME_DATE')]);
      const lastGameRows = rows.filter((r) => r[idx('GAME_DATE')] === lastDate);
      let away = null;
      let home = null;
      for (const r of lastGameRows) {
        const matchup = r[idx('MATCHUP')];
        const tricode = r[idx('TEAM_ABBREVIATION')];
        if (matchup.includes('vs.')) home = tricode;
        else if (matchup.includes('@')) away = tricode;
      }
      const teamName = (tricode) => NBA_TEAMS.find((t) => t.tricode === tricode)?.name || tricode;
      return {
        heading: `No games today — last game played (${lastDate})`,
        games: [
          {
            gameId: lastGameRows[0][idx('GAME_ID')],
            awayTricode: away,
            homeTricode: home,
            awayName: teamName(away),
            homeName: teamName(home),
            status: 'Final',
          },
        ],
      };
    }
  } catch (e) {
    console.error('getHomeData: last-game fallback failed:', e.message);
  }

  return { heading: 'No games available', games: [] };
}

// Official match highlights are posted by the HOME club's own YouTube
// channel, not the league's (confirmed live: Everton's highlights for
// an Everton match were on Everton's channel, not @premierleague's).
// Handles for clubs not yet in this list (promoted/relegated teams
// change season to season) fall back to no highlights link for now —
// add them one by one as needed, same pattern as everything else here.
const EPL_CLUB_YOUTUBE_HANDLES = {
  Arsenal: 'Arsenal',
  'Aston Villa': 'AVFCOfficial',
  Bournemouth: 'afcbournemouth',
  Brentford: 'BrentfordFC',
  Brighton: 'OfficialBHAFC',
  'Brighton and Hove Albion': 'OfficialBHAFC',
  Burnley: 'burnleyofficial',
  Chelsea: 'ChelseaFC',
  'Crystal Palace': 'CPFC',
  Everton: 'Everton',
  Fulham: 'FulhamFC',
  'Leeds United': 'LeedsUnited',
  Leeds: 'LeedsUnited',
  Liverpool: 'LiverpoolFC',
  'Manchester City': 'mancity',
  'Manchester United': 'ManUtd',
  Newcastle: 'NUFC',
  'Newcastle United': 'NUFC',
  'Nottingham Forest': 'NFFC',
  Sunderland: 'SunderlandAFC',
  Tottenham: 'SpursOfficial',
  'Tottenham Hotspur': 'SpursOfficial',
  'West Ham': 'WestHamUnited',
  'West Ham United': 'WestHamUnited',
  Wolves: 'Wolves',
  'Wolverhampton Wanderers': 'Wolves',
};

// PulseLive's own club.id does NOT correspond to
// resources.premierleague.com/premierleague/badges/50/t{id}.png's
// numbering (confirmed empirically: club.id 1/4/7 for Arsenal/Chelsea/
// Everton actually returned Man Utd/Newcastle/Aston Villa's crests on
// that CDN) — a third PL-side ID mismatch, same category of bug as the
// PulseLive-vs-site match-id mismatch above. Sidestepping it entirely
// by using ESPN's team-logo CDN instead, keyed by PulseLive's
// club.name string (ESPN's own numeric team ids, confirmed directly
// against https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams).
const EPL_CLUB_CRESTS = {
  Arsenal: 359,
  'Aston Villa': 362,
  Bournemouth: 349,
  Brentford: 337,
  'Brighton and Hove Albion': 331,
  Burnley: 379,
  Chelsea: 363,
  'Crystal Palace': 384,
  Everton: 368,
  Fulham: 370,
  'Leeds United': 357,
  Liverpool: 364,
  'Manchester City': 382,
  'Manchester United': 360,
  'Newcastle United': 361,
  'Nottingham Forest': 393,
  Sunderland: 366,
  'Tottenham Hotspur': 367,
  'West Ham United': 371,
  'Wolverhampton Wanderers': 380,
};

function eplCrestUrl(clubName) {
  const espnId = EPL_CLUB_CRESTS[clubName];
  return espnId ? `https://a.espncdn.com/i/teamlogos/soccer/500/${espnId}.png` : null;
}

// Premier League home data: real recent results from PulseLive (the
// API that actually powers premierleague.com's own site). Deliberately
// does NOT include scores at all in what's returned — not just hidden
// in the UI, actually absent from the payload — since the whole point
// is spoiler safety, and there's no reason to even have the score
// value in the renderer if it should never be shown.
// Crest URL pattern (resources.premierleague.com/.../t{clubId}.png) is
// unverified — try it, and it just won't show if wrong (low-cost to
// get wrong, unlike a video URL).
async function getEplHomeData(view) {
  try {
    const url = 'https://footballapi.pulselive.com/football/fixtures?comps=1&page=0&pageSize=10&sort=desc&statuses=C';
    const text = await fetchViaPage(view, url);
    const data = JSON.parse(text);
    const matches = (data.content || []).slice(0, 6).map((m) => {
      const [teamA, teamB] = m.teams; // array order observed to be [home, away]
      return {
        id: m.id,
        homeName: teamA.team.name,
        awayName: teamB.team.name,
        homeCrest: eplCrestUrl(teamA.team.club.name),
        awayCrest: eplCrestUrl(teamB.team.club.name),
        date: (m.kickoff && m.kickoff.label) || '',
      };
    });
    return { heading: 'Premier League — recent matches', matches };
  } catch (e) {
    console.error('getEplHomeData failed:', e.message);
    return { heading: 'Premier League — unavailable', matches: [] };
  }
}

// Champions League home data: unlike PulseLive (EPL), ESPN's own
// soccer scoreboard gives fixtures, real scores, AND team crests all
// in one payload with no separate id-mismatch to work around — a much
// simpler source than what EPL needed. Score is still deliberately
// left out of what's returned/displayed, matching the no-spoilers
// pattern used everywhere else.
async function getClHomeData(view) {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 10 * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=${fmt(start)}-${fmt(end)}`;
    const text = await fetchViaPage(view, url);
    const data = JSON.parse(text);
    const completed = (data.events || []).filter(
      (ev) => ev.competitions?.[0]?.status?.type?.name === 'STATUS_FULL_TIME'
    );
    const matches = completed.slice(-6).reverse().map((ev) => {
      const comp = ev.competitions[0];
      const home = comp.competitors.find((c) => c.homeAway === 'home');
      const away = comp.competitors.find((c) => c.homeAway === 'away');
      return {
        homeName: home.team.displayName,
        awayName: away.team.displayName,
        homeCrest: home.team.logo,
        awayCrest: away.team.logo,
        date: ev.date.slice(0, 10),
      };
    });
    return { heading: 'Champions League — recent matches', matches };
  } catch (e) {
    console.error('getClHomeData failed:', e.message);
    return { heading: 'Champions League — unavailable', matches: [] };
  }
}

// One dispatch table per league: resolve() turns a generic game
// descriptor ({ league, ...fields }, sent from the renderer) into what a
// pane needs to actually show it. Keeping this as data (not scattered
// across IPC handlers) is what lets a game be opened into ANY pane slot
// generically — the dynamic grid doesn't special-case NBA vs EPL beyond
// this table — and gives future leagues (Champions League, etc.) a
// natural place to plug in.
const LEAGUE_PROVIDERS = {
  nba: {
    resolve(game) {
      const url = `https://www.nba.com/game/${game.awayTricode.toLowerCase()}-vs-${game.homeTricode.toLowerCase()}-${game.gameId}?watchFullGame`;
      return { url, skipCapable: true, label: `${game.awayName} @ ${game.homeName}` };
    },
  },
  epl: {
    resolve(game) {
      const label = `${game.homeName} v ${game.awayName}`;
      const handle = EPL_CLUB_YOUTUBE_HANDLES[game.homeName];
      if (!handle) {
        return { url: null, error: `No highlights channel configured yet for ${game.homeName}.` };
      }
      return {
        url: `https://www.youtube.com/@${handle}`,
        skipCapable: false,
        label,
        searchQuery: label,
      };
    },
  },
  cl: {
    resolve(game) {
      return {
        url: `https://www.uefa.com/uefachampionsleague/fixtures-results/#/d/${game.date}`,
        skipCapable: false,
        label: `${game.homeName} v ${game.awayName}`,
      };
    },
  },
};

// Does whatever's needed after a pane has been pointed at a resolved
// game to actually land on real content — a plain load for most
// leagues (createPane's own did-finish-load handler reveals it once
// ready), or EPL's scripted-search-then-reveal dance for leagues whose
// URL is a channel page rather than a direct deep link.
function openGameContent(win, pane, game, resolved, layoutAll) {
  win.webContents.send('pane-status', { id: pane.id, state: 'loading' });

  // Both EPL and Champions League land on a channel/listing page first
  // and need a script to actually reach the highlights video — run
  // that script once the page loads, keeping the pane hidden
  // (autoNavigating) until it resolves either way, so the intermediate
  // page never flashes on screen.
  let script = null;
  let initialDelayMs = 500;
  if (game.league === 'epl') {
    script = EPL_SEARCH_SCRIPT(resolved.searchQuery);
  } else if (game.league === 'cl') {
    script = CL_HIGHLIGHT_SCRIPT(game.homeName, game.awayName);
    // UEFA's fixtures page ships a much heavier JS bundle than
    // YouTube's — confirmed live it needs noticeably longer to finish
    // rendering.
    initialDelayMs = 2500;
  }
  if (!script) return;

  pane.autoNavigating = true;
  const reveal = () => {
    pane.autoNavigating = false;
    pane.ready = true;
    win.webContents.send('pane-status', { id: pane.id, state: 'ready' });
    layoutAll();
  };
  pane.view.webContents.once('did-finish-load', () => {
    // Give the page's own client-side JS a beat to finish wiring up
    // before we drive it.
    setTimeout(() => {
      pane.view.webContents
        .executeJavaScript(script)
        .then((result) => console.log(`pane ${pane.id}: ${game.league} highlight script result`, result))
        .catch((err) => console.error(`pane ${pane.id}: ${game.league} highlight script failed`, err))
        .finally(reveal);
    }, initialDelayMs);
  });
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

  // Permanently-hidden panes (never in the grid, bounds always 0x0) that
  // exist purely to run fetchViaPage's page-context fetch() trick for
  // home-page data. Previously getHomeData/getEplHomeData just reused
  // panes[0]/panes[1] since those always existed — but the grid is
  // dynamic now (can be empty, e.g. on first launch before any game is
  // opened), so home-data fetching needs views that aren't tied to
  // whatever the user happens to have open. One utility view per league
  // family, not a single shared one: footballapi.pulselive.com checks
  // the request's Origin header against premierleague.com, so a fetch
  // issued from an nba.com-loaded page is rejected as cross-origin
  // (confirmed — it fails with a plain "Failed to fetch").
  const createUtilityView = (url) => {
    const view = new WebContentsView();
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.webContents.loadURL(url);
    return view;
  };
  const utilityViewNba = createUtilityView('https://www.nba.com');
  const utilityViewEpl = createUtilityView('https://www.premierleague.com');

  let splitRatio = 0.5;
  let nextPaneId = 1;
  const panes = []; // array ORDER = grid position; pane.id = stable identity for all messaging

  // The panes are native WebContentsViews layered on top of the window
  // in absolute coordinates — a completely separate layer from the
  // renderer's own HTML/CSS. Hiding the renderer's #grid <div> does
  // NOT hide them; the main process has to explicitly zero out their
  // bounds itself. currentView tracks which "screen" is active so
  // layout and audio-muting both respect it.
  let currentView = 'home';

  const hideAllPanes = () => {
    panes.forEach((pane) => pane.view.setBounds({ x: 0, y: 0, width: 0, height: 0 }));
  };

  const layoutAll = () => {
    if (currentView !== 'grid') {
      hideAllPanes();
      return;
    }
    layoutPanes(win, panes, splitRatio);
  };

  let focusedPaneId = null;
  const applyAudioMuting = () => {
    if (currentView !== 'grid') {
      panes.forEach((pane) => pane.view.webContents.setAudioMuted(true));
    } else {
      panes.forEach((pane) => pane.view.webContents.setAudioMuted(pane.id !== focusedPaneId));
    }
  };

  const setView = (view) => {
    currentView = view;
    layoutAll();
    applyAudioMuting();
  };

  const setFocus = (id) => {
    if (!panes.some((p) => p.id === id)) return;
    focusedPaneId = id;
    applyAudioMuting();
    win.webContents.send('focus-changed', { id });
  };

  const broadcastPanesConfig = () => {
    win.webContents.send(
      'panes-config',
      panes.map((p) => ({ id: p.id, label: p.label, skipCapable: !!p.skip }))
    );
  };

  // Tears down one pane's WebContentsView entirely — used both when
  // closing a pane for good and when replacing its content (which
  // rebuilds a fresh pane object in the same slot, since skip-capability
  // is wired up once at construction and can't be safely toggled on a
  // live view).
  const destroyPaneView = (pane) => {
    try { win.contentView.removeChildView(pane.view); } catch (e) { /* already gone */ }
    try { pane.view.webContents.close(); } catch (e) { /* already gone */ }
  };

  // Resolves a generic game descriptor via its league's provider and
  // either replaces the pane at `existingIndex` (reusing its id — a
  // swap should look, from the outside, like that one pane's content
  // just changed) or appends a new one. Validates the resolved URL
  // BEFORE tearing anything down, so a bad selection (e.g. an EPL club
  // with no mapped YouTube handle) never destroys a working pane.
  const setPane = (existingIndex, game) => {
    const provider = LEAGUE_PROVIDERS[game.league];
    const resolved = provider.resolve(game);
    if (!resolved.url) {
      console.log(`setPane: could not resolve "${game.league}" game:`, resolved.error);
      win.webContents.send('home-notice', { message: resolved.error || 'That game is not available yet.' });
      return null;
    }

    let id;
    if (existingIndex != null) {
      destroyPaneView(panes[existingIndex]);
      id = panes[existingIndex].id;
    } else {
      id = nextPaneId++;
    }

    const pane = createPane(
      win,
      id,
      { url: resolved.url, skipCapable: resolved.skipCapable, label: resolved.label, league: game.league },
      layoutAll
    );

    if (existingIndex != null) panes[existingIndex] = pane;
    else panes.push(pane);

    openGameContent(win, pane, game, resolved, layoutAll);
    broadcastPanesConfig();
    return pane;
  };

  const closePane = (id) => {
    const idx = panes.findIndex((p) => p.id === id);
    if (idx === -1) return;
    destroyPaneView(panes[idx]);
    panes.splice(idx, 1);
    if (focusedPaneId === id) {
      focusedPaneId = panes[0] ? panes[0].id : null;
      win.webContents.send('focus-changed', { id: focusedPaneId });
    }
    broadcastPanesConfig();
    if (panes.length === 0) {
      setView('home');
      win.webContents.send('return-home');
    } else {
      layoutAll();
      applyAudioMuting();
    }
  };

  // Tears down every existing pane and opens exactly the given games
  // (1-4) as a fresh grid — used both for a plain single-game click and
  // for "Watch Selected" in multi-view mode. Deliberately does NOT try
  // to preserve/diff against whatever was already open: "depending on
  // what you press" means pressing a game shows exactly that game, not
  // whatever was already in the grid plus this one.
  const openFreshGrid = (games) => {
    panes.splice(0).forEach(destroyPaneView);
    games.slice(0, 4).forEach((game) => setPane(null, game));
    if (panes.length === 0) {
      // Every game failed to resolve (e.g. an EPL club with no mapped
      // handle) — stay on the home page rather than showing an empty
      // grid; setPane already sent a home-notice for each failure.
      setView('home');
      return;
    }
    focusedPaneId = panes[0].id;
    setView('grid');
    win.webContents.send('show-grid');
    win.webContents.send('focus-changed', { id: focusedPaneId });
    applyAudioMuting();
  };

  win.webContents.on('did-finish-load', () => {
    broadcastPanesConfig();
    setView('home');
  });

  ipcMain.on('show-home', () => setView('home'));

  ipcMain.on('focus-pane', (_event, id) => setFocus(id));
  ipcMain.on('retry-pane', (_event, id) => {
    const pane = panes.find((p) => p.id === id);
    if (!pane) return;
    pane.ready = false;
    pane.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    win.webContents.send('pane-status', { id, state: 'loading' });
    pane.view.webContents.reload();
  });
  ipcMain.on('jump-to-quarter', (_event, { id, quarter }) => {
    const pane = panes.find((p) => p.id === id);
    if (pane && pane.skip) pane.skip.jumpToQuarter(quarter);
  });
  ipcMain.on('nudge-quarter', (_event, { id, direction }) => {
    const pane = panes.find((p) => p.id === id);
    if (!pane || !pane.skip) return;
    if (direction === 'next') pane.skip.stepNext();
    else pane.skip.stepPrev();
  });
  ipcMain.on('set-split-ratio', (_event, ratio) => {
    splitRatio = Math.max(0.2, Math.min(0.8, ratio));
    layoutAll();
  });

  ipcMain.handle('get-home-data', () => getHomeData(utilityViewNba));
  ipcMain.handle('get-teams', () => NBA_TEAMS);
  ipcMain.handle('get-favorite-team', () => loadPrefs().favoriteTeam || null);
  ipcMain.on('set-favorite-team', (_event, tricode) => saveFavoriteTeam(tricode));
  ipcMain.handle('get-epl-home-data', () => getEplHomeData(utilityViewEpl));
  ipcMain.handle('get-cl-home-data', () => getClHomeData(utilityViewNba));

  // Plain click on the home page (multi-view off): opens exactly the
  // games pressed, discarding whatever grid existed before. Also used
  // by "Watch Selected" in multi-view mode with up to 4 games at once.
  ipcMain.on('open-games', (_event, games) => openFreshGrid(games));

  // "+ Add game" from within the grid: appends one more pane without
  // touching any existing one.
  ipcMain.on('add-pane', (_event, game) => {
    if (panes.length >= 4) return;
    setPane(null, game);
    setView('grid');
    win.webContents.send('show-grid');
  });

  // "Swap" on a specific pane: replaces just that pane's content,
  // leaving every other pane running untouched.
  ipcMain.on('replace-pane', (_event, { id, game }) => {
    const idx = panes.findIndex((p) => p.id === id);
    if (idx === -1) return;
    setPane(idx, game);
    setView('grid');
    win.webContents.send('show-grid');
  });

  ipcMain.on('close-pane', (_event, id) => closePane(id));

  win.on('resize', layoutAll);

  // --- Calibration hotkeys (operate on the currently FOCUSED pane) ---
  // Cmd+Shift+L: print the full discontinuity/gap table.
  // Cmd+Shift+1/2/3/4: jump to that quarter's guessed start.
  // Cmd+Shift+Right: step to the NEXT discontinuity and seek there.
  // Cmd+Shift+Left: step to the PREVIOUS discontinuity and seek there.
  // (Not Cmd+Shift+[/]: Cmd+Shift+[ silently did nothing in testing,
  // almost certainly colliding with macOS's own "previous Space"
  // Mission Control shortcut before it ever reached the app.)
  const focusedPane = () => panes.find((p) => p.id === focusedPaneId) || null;

  const focusedSkip = () => {
    const pane = focusedPane();
    if (!pane || !pane.skip) {
      console.log(`pane ${focusedPaneId} doesn't support skip-to-quarter (not an HLS/manifest-based service).`);
      return null;
    }
    return pane.skip;
  };

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    const skip = focusedSkip();
    if (skip) skip.dumpTable();
  });

  // Cmd+Shift+U: log the focused pane's current URL — handy for finding
  // deep-link URLs on a service by navigating manually, then reading
  // out what page you landed on (same pattern used to find League
  // Pass's game URLs earlier).
  globalShortcut.register('CommandOrControl+Shift+U', () => {
    const pane = focusedPane();
    if (!pane) return;
    console.log(`pane ${pane.id} URL:`, pane.view.webContents.getURL());
  });

  // Scans the focused pane's DOM for likely search-box elements — used
  // to find a new service's real search input/button before scripting
  // it (this is how EPL's YouTube search box was found), rather than
  // guessing selectors blind. Kept as a permanent dev tool since the
  // same technique will be needed for future leagues.
  // General-purpose, shadow-DOM-aware DOM inspector for the focused
  // pane — used to find real selectors on a new site rather than
  // guessing blind (this is how EPL's YouTube search box was found).
  // Pierces shadow roots (plain querySelectorAll/textContent don't —
  // confirmed this matters: UEFA's site is built on Stencil web
  // components and was completely invisible to the non-piercing
  // version of this scan). Dumps every element whose own deep text
  // contains DOM_SCAN_QUERY (edit the constant below per investigation,
  // rebuild, and press the hotkey — quicker than adding a new hotkey
  // each time).
  globalShortcut.register('CommandOrControl+Shift+D', async () => {
    const pane = focusedPane();
    if (!pane) return;
    try {
      const result = await pane.view.webContents.executeJavaScript(`
        (() => {
          function deepQueryAll(root) {
            const out = [];
            const walk = (node) => {
              node.querySelectorAll('*').forEach((el) => {
                out.push(el);
                if (el.shadowRoot) walk(el.shadowRoot);
              });
            };
            walk(root);
            return out;
          }
          function deepText(el) {
            let text = '';
            el.childNodes.forEach((n) => {
              if (n.nodeType === Node.TEXT_NODE) text += n.textContent;
              else if (n.nodeType === Node.ELEMENT_NODE) text += deepText(n);
            });
            if (el.shadowRoot) text += deepText(el.shadowRoot);
            return text;
          }
          const query = ${JSON.stringify(DOM_SCAN_QUERY)};
          const matches = deepQueryAll(document)
            .filter((el) => deepText(el).includes(query))
            .sort((a, b) => deepText(a).length - deepText(b).length)
            .slice(0, 20)
            .map((el) => ({
              tag: el.tagName,
              id: el.id || null,
              className: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
              role: el.getAttribute('role'),
              ariaLabel: el.getAttribute('aria-label'),
              text: deepText(el).trim().slice(0, 60),
            }));
          return matches;
        })()
      `);
      console.log(`DOM scan for "${DOM_SCAN_QUERY}":`, JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('DOM scan failed:', err);
    }
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
