const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDiscontinuities, guessQuarterStartIndex, fmtTime } = require('../src/lib/skip-heuristics');

const manifest = (lines) => ['#EXTM3U', ...lines].join('\n');

test('parseDiscontinuities records the runtime offset of every discontinuity', () => {
  const text = manifest([
    '#EXTINF:6.0,', 'a.ts',
    '#EXTINF:6.0,', 'b.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:4.5,', 'c.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:3.0,', 'd.ts',
    '#EXT-X-ENDLIST',
  ]);
  const parsed = parseDiscontinuities(text);
  assert.deepEqual(parsed.discontinuities, [12, 16.5]);
  assert.equal(parsed.total, 19.5);
  assert.equal(parsed.isVod, true);
});

test('parseDiscontinuities treats a playlist without ENDLIST as live, not VOD', () => {
  const parsed = parseDiscontinuities(manifest(['#EXTINF:6.0,', 'a.ts', '#EXT-X-DISCONTINUITY']));
  assert.equal(parsed.isVod, false);
  assert.deepEqual(parsed.discontinuities, [6]);
});

test('parseDiscontinuities accepts PLAYLIST-TYPE:VOD and CRLF line endings', () => {
  const parsed = parseDiscontinuities('#EXTM3U\r\n#EXT-X-PLAYLIST-TYPE:VOD\r\n#EXTINF:5.0,\r\na.ts\r\n');
  assert.equal(parsed.isVod, true);
  assert.equal(parsed.total, 5);
});

test('parseDiscontinuities handles an empty manifest', () => {
  assert.deepEqual(parseDiscontinuities(''), { discontinuities: [], total: 0, isVod: false });
});

// A synthetic two-hour game with 12 evenly spaced broadcast breaks.
const total = 7200;
const evenBreaks = Array.from({ length: 12 }, (_, i) => (i + 1) * 550);

test('guessQuarterStartIndex picks the middle discontinuity by count for Q3 (halftime)', () => {
  assert.equal(guessQuarterStartIndex(evenBreaks, total, 3), 6);
});

test('guessQuarterStartIndex extends the same idea recursively to Q1, Q2 and Q4', () => {
  assert.equal(guessQuarterStartIndex(evenBreaks, total, 1), 0);
  assert.equal(guessQuarterStartIndex(evenBreaks, total, 2), 3);
  assert.equal(guessQuarterStartIndex(evenBreaks, total, 4), 9);
});

test('guessQuarterStartIndex returns -1 when there is nothing to choose from or the quarter is invalid', () => {
  assert.equal(guessQuarterStartIndex([], total, 3), -1);
  assert.equal(guessQuarterStartIndex(evenBreaks, total, 0), -1);
  assert.equal(guessQuarterStartIndex(evenBreaks, total, 5), -1);
});

test('guessQuarterStartIndex falls back to the time fraction when the by-count guess is implausible', () => {
  // All breaks cluster at the end of the runtime, so the middle one (index 2,
  // at 6200s = 86%) is outside Q3's plausible 30-70% window.
  const clustered = [6000, 6100, 6200, 6300];
  assert.equal(guessQuarterStartIndex(clustered, total, 3), 0);
});

test('guessQuarterStartIndex clamps to a valid index for a single discontinuity', () => {
  const index = guessQuarterStartIndex([3600], total, 4);
  assert.ok(index === 0);
});

test('fmtTime formats seconds as h:mm:ss', () => {
  assert.equal(fmtTime(0), '0:00:00');
  assert.equal(fmtTime(3725), '1:02:05');
  assert.equal(fmtTime(59.6), '0:01:00');
  assert.equal(fmtTime(-5), '0:00:00');
});
