// Pure logic for the spoiler-safe skip-to-quarter feature: HLS manifest
// parsing and the heuristic that picks which broadcast break starts a quarter.
// Kept free of Electron so it can be unit-tested.

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
// docs/DESIGN_LOG.md (Phase 3).

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

module.exports = { parseDiscontinuities, guessQuarterStartIndex, fmtTime };
