const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeClForSearch, nflNickname } = require('../src/lib/names');

test('normalizeClForSearch uses the alias map for genuine abbreviations', () => {
  assert.equal(normalizeClForSearch('Manchester City'), 'Man City');
  assert.equal(normalizeClForSearch('Paris Saint-Germain'), 'Paris');
  assert.equal(normalizeClForSearch('Borussia Dortmund'), 'B. Dortmund');
  assert.equal(normalizeClForSearch('Internazionale'), 'Inter');
});

test('normalizeClForSearch strips generic club prefixes and suffixes', () => {
  assert.equal(normalizeClForSearch('FC Porto'), 'Porto');
  assert.equal(normalizeClForSearch('AS Roma'), 'Roma');
  assert.equal(normalizeClForSearch('VIKING FK'), 'VIKING');
  assert.equal(normalizeClForSearch('1. FC Union Berlin'), 'Union Berlin');
});

test('normalizeClForSearch leaves names that need no change alone', () => {
  for (const name of ['Real Madrid', 'Bayern Munich', 'Aston Villa', 'Arsenal', 'Club Brugge']) {
    assert.equal(normalizeClForSearch(name), name);
  }
});

test('nflNickname is the last word of the full team name', () => {
  assert.equal(nflNickname('New England Patriots'), 'Patriots');
  assert.equal(nflNickname('San Francisco 49ers'), '49ers');
  assert.equal(nflNickname('Washington Commanders'), 'Commanders');
});
