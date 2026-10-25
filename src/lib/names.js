// Maps the team names our data sources use to the names each streaming
// site actually displays, so on-page text search can find the right match.
// Pure and Electron-free so it can be unit-tested.

// ESPN's team names don't match UEFA's own site names (confirmed live:
// searched for "FC Porto"/"Manchester City" against a page showing
// "Porto"/"Man City" — a real, understood mismatch, not a guess). Two
// independent fixes, since one alone doesn't cover both cases: (1) a
// generic prefix strip handles "FC Porto" -> "Porto" for any club
// without needing to know it by name; (2) "Manchester" -> "Man" is a
// genuine abbreviation, not an affix, so it needs an explicit alias —
// only added for cases actually confirmed (Man City) or extremely
// well-known/unambiguous (Man Utd, PSG's "Paris" branding, seen on
// UEFA's own video hub) rather than guessing at all ~36 clubs' UEFA
// house style up front. Grow this list the same way EPL's handle map
// grew: when a real match fails, the highlight script's failure log
// now includes exactly what was searched for, so extending this is a
// one-line lookup, not a guess.
const CL_CLUB_NAME_ALIASES = {
  'Manchester City': 'Man City', // confirmed live via automation success
  'Manchester United': 'Man Utd', // not yet confirmed, common convention
  'Paris Saint-Germain': 'Paris', // confirmed via screenshot
  'Borussia Dortmund': 'B. Dortmund', // confirmed via automation failure log
  'Slovan Bratislava': 'S. Bratislava', // confirmed via screenshot
  Internazionale: 'Inter', // confirmed via screenshot
  'Inter Milan': 'Inter', // same club, defensive alt spelling ESPN may use
  'LASK Linz': 'LASK', // confirmed via screenshot
  'Feyenoord Rotterdam': 'Feyenoord', // confirmed via automation failure log
};
const CL_CLUB_PREFIX_STRIP = /^(FC|AC|AS|CF|SC|SV|SL|1\.\s?FC)\s+/i;
const CL_CLUB_SUFFIX_STRIP = /\s+(FK|FC|CF|SC)$/i;

function normalizeClForSearch(name) {
  if (CL_CLUB_NAME_ALIASES[name]) return CL_CLUB_NAME_ALIASES[name];
  return name.replace(CL_CLUB_PREFIX_STRIP, '').replace(CL_CLUB_SUFFIX_STRIP, '');
}

// DAZN's NFL Game Pass schedule shows team nicknames only ("Patriots @
// Seahawks", confirmed live) — unlike soccer club nicknames (which
// need a per-club alias map, see above), every NFL team's nickname is
// reliably just the last word of its full name, so this needs no
// lookup table at all.
function nflNickname(fullName) {
  return fullName.split(' ').pop();
}

module.exports = { normalizeClForSearch, nflNickname, CL_CLUB_NAME_ALIASES };
