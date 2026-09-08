# CourtSide — sport streaming shell

A working name; rename freely. This doc captures the full concept, architecture, and phased build plan as scoped in planning conversations. Treat it as a living reference — update it as decisions change during the build.

## 1. The pitch

A unified desktop shell for watching multiple sports streaming services (League Pass, DAZN, a third service TBD) side by side, using your real accounts, with two standout features:

- **Concurrent multi-game viewing** — 2–4 games in a grid, one "focused" pane at a time for audio/controls.
- **Spoiler-safe skip** — jump straight to a specific quarter/period on the focused game without seeing the score or the giveaway of a longer-than-usual runtime (which would spoil overtime).

Built because you personally watch NBA League Pass the morning after games (Israel time zone) and want to skip to the 4th quarter without spoilers — a real, specific, personally-motivated problem, which is exactly what makes it a strong portfolio project rather than a generic clone.

## 2. Why this project (resume framing)

- Not another LLM wrapper or CRUD app — genuinely distinct from the flood of AI-chatbot side projects.
- Real systems complexity: multi-session window/WebView lifecycle management, concurrent video decoding, state isolation per service.
- A real CV component, scoped honestly as applied computer vision (not ML research) — reads as hireable for general SWE roles, not just ML-specific ones.
- A genuine algorithmic detail: binary search over the video timeline for the skip feature — a nice, concrete "here's a real algorithm I applied" story for interviews.
- On-theme for sport-tech, which is the target industry — this project only makes sense to someone who understands the actual pain points of that space (blackouts, service fragmentation, spoiler anxiety).
- Demoable live — most side projects are hard to show in 5 minutes; this one demos naturally.

## 3. Core architecture

### 3.1 The shell (Electron)

- Each streaming service (League Pass, DAZN, third service) runs as an independent embedded browser instance — Electron's `WebContentsView` (the current API; `BrowserView` is deprecated but equivalent).
- Each instance is a real, unmodified browser session: its own cookies, its own login, its own DRM negotiation. Nothing is scraped, merged, or intercepted — from the streaming service's perspective, this is indistinguishable from opening their site in a normal browser tab.
- Custom shell UI (header, grid layout, pane chrome, service badges) wraps these embedded sessions — needs real design attention so it doesn't look like "iframes stapled together."
- **DRM note:** stock Electron has no bundled Widevine CDM. Using the [castlabs/electron-releases](https://github.com/castlabs/electron-releases) fork (`wvcus` builds), which manages the Widevine CDM via Electron's Component Updater. **Confirmed by testing:** the dev-signed build's CDM works fine against open test streams (Shaka Player demo), but real commercial license servers (NBA League Pass) reject it outright (`DRM_FAILED_LICENSE_REQUEST`) until the packaged app is VMP-signed via castlabs' free EVS service. After signing (`evs-vmp sign-pkg`), League Pass playback works. **This means: every packaged build must go through EVS signing after any binary change — dev mode (`npm start`) will never work against real services, only a signed, packaged build will.**

### 3.2 Multi-pane concurrent viewing

- Grid layout (1/2/4-up), each cell hosting one `WebContentsView`.
- Exactly one pane is "focused" at a time — this pane gets audio (all others muted), the skip/seek control, and CV score/quarter detection.
- Switching focus is a UI-level state change (click a pane), not a re-initialization of the view — sessions stay alive in the background so switching is instant.
- **Known constraint:** concurrent DRM video decode is CPU/GPU-intensive. Validate 2-pane playback is smooth before assuming 4-pane will scale.

### 3.3 Spoiler-safe skip feature

Problem: jump the focused pane's video to the start of a specific quarter/period, without ever rendering a scoreboard or a runtime-based OT giveaway.

**Original pipeline (superseded — see Status below for what actually shipped):**

1. ~~Screen capture, not DOM access.~~ **Confirmed false by testing:** Widevine output protection excludes decoded EME video from all OS-level screen/window capture on macOS, regardless of L1/L3 security level (same reason you can't screen-record Netflix). Pixel-based detection is not viable on this platform.
2. ~~Hidden scan / binary search over the timeline / template matching / OCR.~~ Moot once pixel capture was ruled out — a hidden off-screen scan would capture the same black frame.

**What actually worked:** reading structural boundary markers directly from the HLS manifest (not DRM-protected — only the media segments it references are), and seeking via the video player's own internal API rather than the raw `<video>` element. See the Status section for the full story.

**Scoping decision (already made):** the skip feature only operates on the single focused pane, never all concurrent panes at once — a deliberate performance/complexity tradeoff, stated upfront rather than hidden.

### 3.4 Hide-scores toggle

- Per-pane UI toggle — when enabled, replace any visible score overlay in the app's own UI chrome with "Score hidden," and suppress any score data pulled from an API (see §3.6) for that game.
- This only controls the app's own UI elements. It cannot suppress a scoreboard baked into the underlying broadcast video itself.

### 3.5 Highlights

- From YouTube: YouTube Data API v3 (free tier, daily quota) to search official league/team channels, embedded via standard `iframe`. Fully ToS-compliant, no scraping.
- From existing subscriptions (League Pass, DAZN, etc.): no public highlight-catalog APIs — handled as a deep-link to that service's own highlights section instead.

### 3.6 Schedule/score data

- No scraping of 365Scores (no official free API, only unofficial reverse-engineered wrappers — fragile and legally murky).
- Use TheSportsDB (free tier) or API-Football (generous free tier) for schedules, live scores, and standings.
- Powers: schedule view, blackout info (inferred from public rules, not bypassed), and score data shown outside the hide-scores toggle.

### 3.7 Blackouts

- No workaround exists or should be attempted — blackouts are enforced by the services via geolocation. The app surfaces blackout information (from public schedules/rules) rather than attempting to bypass it.

## 4. Design language

- Custom shell chrome — not raw browser UI. Service identity shown via small badges/labels, not the underlying site's branding bleeding through.
- Consistent visual system: one accent color for "focused" state (2px accent border), muted/quiet treatment for background panes.
- Real states for everything: loading skeletons, empty states, error states (stream failed, login expired) — not blank screens.
- Quarter-progress indicator (pills: Q1/Q2/Q3/Q4) shown for the focused pane only, since that's the only pane with active CV tracking. Background panes show a plain live clock instead.

## 5. Phased build plan

- **Phase 1 — Single-service shell (foundation).** Electron scaffold, single `WebContentsView` embedding NBA League Pass. Custom shell UI: header, single-pane layout, basic service badge. Validate DRM playback works cleanly before building anything else — highest-risk unknown, de-risk first. Milestone: watch a full live/replay game inside the shell, indistinguishable in quality from a normal browser tab. **Platform: macOS only for now.**
- **Phase 2 — Second service + 2-pane concurrent.** Add Yes STING as a second independent view (not DAZN — no subscription). Build the 2-pane grid, focus-switching (click to focus, audio follows). Validate resource usage on target hardware. Milestone: two live games side by side, instant focus switching, no reload.
- **Phase 3 — Spoiler-safe skip.** ~~v1: template matching~~ **Revised — pixel-based CV is not viable (DRM blocks screen capture of decoded video output). Solved instead via HLS manifest structure + the player's own seek API — see Status below.**
- **Phase 4 — Hide-scores toggle + third service.** Yes STING already pulled forward into Phase 2. Build the per-pane hide-scores toggle. Milestone: multiple services embedded, toggle works per-pane independently.
- **Phase 5 — 4-pane grid + polish.** Extend grid to 4-up, re-validate resource usage. Empty-pane "add a game" state, loading/error states throughout. Real budgeted visual polish pass. Milestone: 4 concurrent games, clean visual polish matching design mockups.
- **Phase 6 — Schedule data + highlights (stretch).** TheSportsDB or API-Football integration. YouTube Data API highlight search per followed team. Blackout-awareness surfacing (informational only). Milestone: a "what's on tonight for my teams" view, with highlight reels for games not watched live.

## 6. Deliberate scope decisions (state these explicitly in any writeup/interview)

- Skip feature runs on one focused pane only — a performance tradeoff, not an oversight.
- No attempt to bypass blackouts or merge accounts/credentials across services — each embedded session is a normal, independent login.
- No scraping of private/unofficial APIs (365Scores) — legitimate free alternatives used instead.
- The skip feature ended up being manifest/metadata-driven, not CV-based — an honest pivot forced by a real DRM constraint, arguably a better interview story than the original plan ("here's a real technical wall and the workaround," not "here's some OpenCV I ran").
- Apple TV is out of scope — tvOS doesn't permit the screen capture / browser embedding this relies on. Desktop-only by necessity.

## 7. Tech stack summary

- Shell: Electron via [castlabs/electron-releases](https://github.com/castlabs/electron-releases) (`WebContentsView`-based multi-session embedding, Widevine CDM support)
- Skip feature: HLS manifest parsing (`#EXT-X-DISCONTINUITY` boundaries) via CDP `Fetch` domain interception, seeking via the player's own internal API (Bitmovin Player, found through React's fiber tree)
- Data sources: YouTube Data API v3 (highlights), TheSportsDB or API-Football (schedule/scores)
- Starting scope: basketball (NBA — League Pass, Yes STING)

## Status

- **Phase 1: complete.** Electron scaffold (`WebContentsView`) loads NBA League Pass. DRM confirmed working end-to-end in a VMP-signed, packaged build. App is ad-hoc code-signed (no paid Apple Developer ID yet — fine for local personal use; only needed if distributing to other machines). Custom app icon. Shell UI has a real loading skeleton and error/retry state instead of a blank Chromium load screen, plus the 2px accent-border "focused pane" framing from the design doc (the single pane is implicitly focused for now).

- **Phase 2: 2-pane grid + focus-switching — core mechanics working.** Restructured the single-pane shell into a generic `panes` array (`createPane`/`layoutPanes` in `src/main.js`) laid out as an equal-width row (extending to a 2x2 4-up grid later is just changing `cols`). Each pane gets its own clickable label bar (rendered by the shell's own HTML, not the native view) instead of intercepting clicks on the video itself — simpler than a click-passthrough overlay, and a reasonable v1 UX (click a pane's label to focus it, matching how many multi-cam viewers work). Confirmed live: clicking a label switches the accent-border focus indicator, audio correctly follows focus (only the focused pane has sound, verified switching back and forth), and neither pane reloads or restarts on a focus switch — sessions genuinely stay alive in the background, satisfying the doc's §3.2 requirement that focus-switching is a UI-level state change, not a re-initialization.

  Second pane is YouTube for now, not the real second service — tested this way specifically because the user was between subscriptions (Yes STING → Hot Next TV) the day this was built. The grid/focus code itself is agnostic to what's actually in a pane, so swapping in the real second service is just changing a URL in `paneConfigs`. Skip-to-quarter (`skip: skipCapable ? createSkipEngine(view) : null`) is scoped per-pane and only wired to the League Pass pane; hotkeys now act on whichever pane is currently focused, not a hardcoded one.

  **Not yet done:** resource-usage validation with two *real* concurrent DRM streams (today's test only had one DRM pane; YouTube isn't DRM-decoded the same way) — revisit once the second real subscription is active. Also not yet built: the 4-up grid, and hide-scores toggle (Phase 4).

  **Real quarter-skip UI added (2026-09-08).** The skip-to-quarter feature now has actual buttons on each skip-capable pane (Q1/Q2/Q3/Q4 + `‹`/`›` nudge), not just dev hotkeys — replacing/supplementing `Cmd+Shift+1-4` and `Cmd+Shift+Left/Right`, which still work too (act on whichever pane is focused). Buttons stay disabled until the manifest is confirmed to be a finished VOD (`#EXT-X-ENDLIST`/`#EXT-X-PLAYLIST-TYPE:VOD`) with usable discontinuity data — skipping to a quarter that hasn't happened yet on a still-live game is meaningless, so they never activate for a live broadcast. Confirmed live: buttons enable correctly once a VOD's manifest is captured, and clicking them seeks correctly (Q3 accurate, Q1/Q2/Q4 imprecise as already documented above — the nudge buttons correct that, also confirmed working from the UI).

  **Broader product vision captured for later phases** (not yet built): per-pane "add another game" (grow the grid to a max of 4), a solo-focus/fullscreen mode per pane (other panes keep playing muted in the background for instant return), and a home/schedule page listing all live games across the user's subscriptions that deep-links directly into the right pane+service when clicked — the last one needs a new "which subscription carries this game" routing layer beyond what's in the original plan doc.

### Build & test workflow

```bash
npm run build:mac   # package + VMP-sign + ad-hoc codesign, in one step
npm run open         # launch dist/mac-arm64/CourtSide.app
```

Individual steps (`npm run pack`, `npm run sign:vmp`, `npm run sign:codesign`) are also available. **Any binary change requires the full `build:mac` before testing against real DRM** — `npm start` (dev mode) will never get a license from League Pass, only a signed packaged build will.

EVS account credentials/tokens live in `~/.config/evs`, outside the repo. `.evs-venv/` (the local Python tool for `evs-vmp`) and `dist/` are gitignored. The app icon source (`build/icon.icns`) was generated with `scripts/gen_icon.py` (needs Pillow, not a project dependency) — it's a placeholder abstract mark, not a literal basketball; revisit in the Phase 5 design pass.

- **Phase 3: "skip to start of 2nd half" — working, validated on two real games.** The doc's original pipeline (§3.3) assumed OS-level screen capture happens "after decryption/rendering, so it isn't blocked" — **confirmed false by testing**: Widevine's output protection excludes decoded EME video from all screen/window capture on macOS regardless of L1/L3, and a hidden off-screen scan wouldn't help either (same black frame).

  **Manifest reading:** the HLS media playlist contains real `#EXT-X-DISCONTINUITY` markers at broadcast structural boundaries (timeouts, period transitions) and isn't DRM-protected. Getting the body took three attempts — CDP `Network.getResponseBody` evicts it too fast; replaying the URL via `fetch()`, even with identical cookies, gets HTTP 400 from the CDN's anti-scraping check — before CDP `Fetch` domain interception (`requestStage: 'Response'`, reading the body Chromium already has, then `Fetch.continueResponse`) worked.

  **Seek mechanism:** raw `document.querySelector('video').currentTime = X` stalls this player indefinitely (it manages its own internal buffering state). Fix: `window.bitmovin` is present — the player is **Bitmovin Player**, a commercial SDK with a real `.seek(time)` API — and the live instance (not just the SDK namespace) is reachable by walking up the video element's React fiber tree (`video.__reactFiber$...` → repeated `.return` → a `stateNode` exposing `.play()`/`.seek()`, found 2 levels up in testing). Calling `.seek()` on that instance works cleanly. Implemented generically in `SEEK_SCRIPT` (`src/main.js`): walks the fiber tree for any object with both methods, not hardcoded to a specific depth.

  **Heuristic:** first attempt (pick the discontinuity after the single largest gap, restricted to the 30%–70% window of runtime) failed — landed ~6 minutes into Q3, not at its start, confirmed via the on-screen game clock. Root cause: gap *size* isn't reliable — a mid-quarter timeout can be longer than a "condensed" halftime break, and halftime length itself varies a lot broadcast to broadcast (confirmed: 11.8 min on one real game, 4.85 min on another). Fix (`guessSecondHalfIndex` in `src/main.js`): use the **middle discontinuity by count**, not by gap size — stoppage counts are roughly symmetric across a game even when individual break lengths aren't. Confirmed exactly correct on two different real games (landed exactly at Q3's start both times; zero manual correction needed on the second). Falls back to "closest to the literal time midpoint" if the middle-by-count candidate looks implausible (outside 25%–75% of total runtime) — untested, since it hasn't been needed yet.

  Built an interactive calibration tool alongside this — `Cmd+Shift+L` dumps the full discontinuity/gap table, `Cmd+Shift+1/2/3/4` seek to that quarter's guessed start, `Cmd+Shift+Left`/`Cmd+Shift+Right` step to the previous/next discontinuity and seek there (not `Cmd+Shift+[`/`]` — `[` silently did nothing in testing, almost certainly colliding with macOS's own "previous Space" shortcut). This is how the heuristic bug was actually found and fixed (converging live against the on-screen game clock, not blind rebuild-and-guess cycles), and it's worth keeping as a real feature, not just a dev tool: a single tap to nudge is a reasonable UX for the rare miss, and it never exposes more than the immediately-adjacent break's game state.

  **Broader validation (9 real games tested, 2026-09-06):** raised a fair concern — NBA rules only guarantee *mandatory* timeouts are symmetric between halves (2 per quarter minimum); coaches can call extra discretionary timeouts asymmetrically, so "middle by count" is a statistical heuristic, not a rule-guaranteed one. Tested across regular season, playoff, and Finals games to check:

  | Content | Discontinuities | Result |
  |---|---|---|
  | Regular season ×6 | 12, 12, 12, 14, 12, 12 | 4 exact hits, 2 misses fixed with one `Cmd+Shift+[`/`]` tap |
  | Finals (2026, Game 4) | **0** | Not supported — see below |
  | Finals (different game) | 12 | Exact hit |
  | Playoff | 12 | Exact hit (despite a ~25 min gap-before, likely an extended playoff halftime show) |

  Net: 7/8 automatic hits on content that has discontinuity markers at all, 8/8 within one manual nudge. Misses were off by exactly one index both times, not wildly off. Playoff and Finals broadcasts mostly behave identically to regular season — this isn't a "postseason is different" problem.

  **Known v1 limitation, confirmed real:** this year's Finals Game 4 has **zero** `#EXT-X-DISCONTINUITY` markers in its manifest — a fundamentally different broadcast pipeline (probably no server-side ad-stitching for that content), not something the current approach can work around at all. Handled gracefully: the app detects zero discontinuities, logs a clear "not supported for this broadcast" message, and does nothing further (no seek attempt, no crash, no infinite re-capture loop). Root cause of *which* broadcasts lack these markers is unexplored — deferred to v2, out of scope for now per explicit decision.

  **Generalizing to all four quarters (2026-09-06): Q3 solid, Q1 doesn't matter, Q2/Q4 unsolved after two real attempts.** Extended `guessQuarterStartIndex()` to Q1/Q2/Q4 via the same recursive idea (middle discontinuity of the first/second half's own discontinuities). Results:

  - **Q1** (tip-off): landed still in pregame/warmups (index 0) on the one game tested. Real finding: there's no discontinuity sitting exactly at tip-off — the broadcast flows continuously from pregame into the game, unlike halftime's hard cut. Doesn't matter in practice: **there's no score to spoil before the game starts**, so imprecision here is fine and not worth chasing further.
  - **Q3** (halftime): unaffected, still reliable — see validation above.
  - **Q2 and Q4**: unlike Q3, these transitions are **not guaranteed hard broadcast breaks** (no cut to studio/ads), so there's no structural reason a discontinuity should sit exactly at the boundary. Two independent fixes were tried and both failed for fundamental, non-superficial reasons:
    1. *Safety-bias hack* (shift the guess back by one discontinuity index): fixed one real miss (guess had landed 40s into live Q4 — a confirmed real spoiler exposure) but broke another game entirely, landing in the *wrong* quarter (2:30 left in Q1 for a Q2 guess, 5:14 left in Q3 for a Q4 guess). Discontinuity spacing near these boundaries is too uneven, game to game, for any fixed index offset. Reverted.
    2. *NBA play-by-play wall-clock anchoring*: `stats.nba.com/stats/playbyplayv3` embeds real wall-clock times in "Start of Nth Period (H:MM AM/PM TZ)" descriptions (the older `playbyplayv2`, which also had a dedicated `WCTIMESTRING` field, is confirmed retired — returns `{}` even for a known-good historical game ID from NBA's own docs). Anchored off the validated Q3 discontinuity offset and computed Q2/Q4 via real-time deltas (assuming VOD-time progresses 1:1 with real time). **Confirmed broken**: League Pass VODs are apparently trimmed/compressed relative to the live broadcast (some dead time removed), so a real 50-minute gap between two period starts corresponded to meaningfully less VOD time — landed still deep in the *preceding* quarter, not the target. A different failure mode than the stoppage-count heuristic's, and not fixable by tuning the safety margin.

  **v1 scope decision:** Q3/halftime is the one quarter jump treated as reliable and automatic. Q2/Q4 return a coarse guess that **must** be manually verified with the nudge tool before trusting — never auto-trust them. A real, correct fix would need something that tells us how much (if any) time was trimmed from a specific VOD relative to the live broadcast, which isn't available from anything tried so far.

  Also worth noting: fetching `stats.nba.com` only worked via a page-context `fetch()` (Chromium's real network stack) — a **main-process** `fetch()` call silently hung indefinitely, almost certainly because Node's HTTP client has a different TLS/HTTP fingerprint than a real browser and got caught by anti-bot filtering. Same lesson as the manifest-reading saga: replay-style requests from an unusual client context get blocked in ways that aren't always an explicit error.

  **Still untested:** whether this manifest structure and the Bitmovin/React-fiber seek approach hold up on Yes STING, or on live (non-VOD) League Pass streams — everything validated so far is League Pass VOD replays only.
