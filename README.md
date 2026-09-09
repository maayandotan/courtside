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

### 5a. Actual build sequence (2026-09-09) — supersedes the phase ordering above

The phases above describe *what* to build; actual building surfaced a better *order*. Real usage revealed the app is missing a coherent skeleton — there's no home page at all right now, the grid is hardcoded to exactly 2 panes, and there's no formal way to add a service beyond editing `main.js` by hand. Rather than keep polishing one feature at a time, the plan going forward is to get a *thin, working slice* of every major flow in place first, then do a depth pass across all of them:

- **v0.3 — Home/schedule page. Done (2026-09-09).** Browse real games, click one, it opens in a pane. Includes a favorite-team picker (persisted), but *not* wired into any scoring yet — that's v0.7. See the Status section below for the real data sources and a genuine architecture bug this surfaced.
- **v0.4 — Dynamic grid. Done (2026-09-09).** Pressing a game now opens exactly that game, not the old fixed "always NBA + Prem" 2-pane. A Multi-View toggle on the home page lets you pick up to 4 games and open them together; panes can be independently closed (others keep playing), swapped (pick a different game for one pane without touching the rest — a small "picking a replacement" banner on the home page routes the next click into that specific pane), or added (a header "+ Add game" button while in the grid, up to 4 total). Solo-focus/fullscreen-per-pane from the original plan is deferred to a later pass.
- **v0.5 — Formal Provider interface.** Turn the ad-hoc `skipCapable` flag into an explicit adapter/capability-detection pattern (open/play/pause/seek/getCurrentTime/getGameState, with per-service capability flags) *before* wiring in more services, not after.
- **v0.6 — Hide-scores toggle.** Small, self-contained; rounds out the spoiler-safety story alongside skip-to-quarter.
- **v0.7 — Recommendation engine v0.** One simple mode (e.g. closest final margin) to prove the "what to watch" pillar exists, with the favorite-team weighting from v0.3 wired in for real (favorite team's games rank at or near the top).
- **v1.0 — Depth pass.** Hover-audio-switching, saved/draggable layouts, better Q2/Q4 precision (if a real fix is ever found), more real services, a real visual design pass, more recommendation modes (Best Performance, Upset of the Night, etc.), spoiler-free recommendation reveal (show "⭐ Highly Recommended" without the reason until after watching).

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

  **Resizable divider added (2026-09-08).** Drag the thin bar between the two panes to change the split (e.g. League Pass at 2/3 width instead of a fixed 50/50) — clamped to 20%-80% so neither pane can be squeezed to nothing. The ratio is tracked in the renderer for the divider's own live drag feedback and mirrored to the main process (`set-split-ratio` IPC) so the native `WebContentsView` bounds actually match. Only meaningful for exactly 2 panes right now — `layoutPanes()` falls back to equal division otherwise; a per-row/column ratio system for the future 4-up grid doesn't exist yet.

  **Second pane swapped from YouTube to FIFA+ for DRM testing (2026-09-08).** YouTube was a fine placeholder for pure grid/focus mechanics but isn't DRM-decoded, so it couldn't validate concurrent DRM decode at all. [FIFA+](https://www.fifa.com/fifaplus/en/) is free, globally available (no geo-block issues), and is real DRM-protected sports content — confirmed loading correctly in the second pane alongside League Pass. (Note: the initial guess at its URL, `plus.fifa.com`, doesn't resolve — the real one is `www.fifa.com/fifaplus/en/`.) FIFA+ turned out to have no easily accessible live/full-match playback when actually tested, so it didn't end up usable for the resource-usage test below — kept in mind as a fallback option, not removed from consideration.

  **Hot Next TV investigated as the real second service — live channels are architecturally incompatible with CourtSide (2026-09-08).** Confirmed directly with the user: Hot Next TV's live channels (Sport 5, One, etc.) are **app-only**, with no web page to load at all. This directly answers an earlier product question ("can we deep-link to a specific live channel") — no, not for this service, and not something more engineering effort fixes: `WebContentsView` can only embed web content, and there is no web surface for live channels to embed. This would also be a step outside the project's own stated design principle (§3.1: every embedded session should be "indistinguishable from opening their site in a normal browser tab") — reverse-engineering a native app's private API to fake it was considered and deliberately rejected as inconsistent with that principle, not just harder. Hot Next TV's website *does* have a real player for VOD content, so it's not a total dead end for on-demand content, just for the live-TV use case that motivated wanting it as a second pane in the first place.

  **Resource-usage validation: done, with DAZN as the real second DRM stream (2026-09-08).** DAZN's website has real live content playable without needing to complete a paid subscription flow — swapped in as the second pane and confirmed: a real League Pass game and a real DAZN live stream playing concurrently, both smooth, no stuttering, and audio-follows-focus still worked correctly switching between two genuinely live real streams (not just one live + one placeholder, like every earlier test this session). Measured resource usage on this machine (Apple Silicon) with both playing: **~78% CPU summed across all CourtSide processes/cores, ~13% memory** — modest, well under a single CPU core's worth of work when normalized against total available cores. This is the first real evidence that the doc's original "validate 2-pane before assuming 4-pane" concern (§3.2) has real headroom, though the 4-pane case itself is still untested. DAZN itself remains a placeholder — the user doesn't have a paid subscription — but is now the best available real-DRM stand-in for this kind of testing.

  **DAZN's default pane URL confirmed and login-persistence quirk noted (2026-09-08).** Default is a specific free replay fixture (`dazn.com/en-IL/fixture/ContentId:.../.../...`) so there's always something playable without hunting through DAZN's browse UI first — same reasoning as League Pass loading `nba.com/watch` rather than the bare homepage. Confirmed: logging in via Google OAuth on DAZN does **not** persist across app relaunches, unlike League Pass's regular login, which does. Likely explanation: OAuth-based sessions are often shorter-lived or treated as less trusted than a direct account login, especially in an embedded browser context — not an app bug, and not worth engineering around for a placeholder test service. Added `Cmd+Shift+U` (logs the focused pane's current URL) as a small permanent dev tool — this is exactly how the DAZN fixture URL itself was found, and it'll be useful for finding deep-link URLs on future services too.

  **Home page multi-league glow-up: Premier League added end-to-end, as the one league fully validated before extending to others (2026-09-09).** Team crest logos added to the NBA game rows too. Premier League chosen specifically because it has a strong site with match content — but no full-match-replay subscription exists for it in Israel besides cable, so (per explicit user decision) it defaults to **official highlights** instead of full replay, matching the "last completed game" pattern already used for NBA. This surfaced three separate real technical walls, in order:

  1. **PulseLive's own IDs don't match its own site's URL scheme.** Premier League's home data comes from its backing API (`footballapi.pulselive.com/football/fixtures`), not from ESPN or the site's own public URLs — a third ID system. The fixture's own `id` field (e.g. `128943`) does not match the id used in `premierleague.com`'s own match-page URLs (e.g. `2645221`) — confirmed, not a bug in our code. No reliable per-match deep link could be constructed from this API at all, for the site or for a highlights page (`/highlights` doesn't exist as a URL). This forced abandoning "link straight to this match's page" entirely.
  2. **Highlights live on the home CLUB's own YouTube channel, not the league's.** Real fix: `EPL_CLUB_YOUTUBE_HANDLES` maps each club's full name to its official handle (must include the season's current 20 clubs — missed the three 2025-26 promotions, Burnley/Leeds United/Sunderland, on the first pass, which silently no-op'd when clicked; now surfaces a visible `pane-status: error` instead of nothing).
  3. **A raw `youtube.com/@handle/search?query=X` `loadURL()` doesn't render search results.** Confirmed live (manually searching within a channel, then reading the resulting URL back via the `Cmd+Shift+U` hotkey) that this URL syntax is correct, but a fresh top-level navigation to it renders as a plain channel page — YouTube's SPA only runs the search route on real client-side navigation, not a cold load. Fixed by scripting a genuine-looking search instead: load the plain channel page, then (via `executeJavaScript`) set YouTube's real masthead search input using the native `HTMLInputElement.value` setter (a plain `.value =` doesn't register with React's controlled-input tracking), dispatch an `input` event, click the real submit button, poll for the first `ytd-video-renderer` search result (naturally skips ad slots, which use other element types), and click it. The whole sequence runs while the pane stays collapsed to 0×0 bounds (`pane.autoNavigating`) so the intermediate channel/search pages never visibly flash — only the final video reveals the pane. Not 100% reliable yet: some official channels' searches still land wrong or the video player itself intermittently errors even on a real, working video (visible when comparing against a normal, manually-run YouTube search) — accepted as a known gap rather than pursued further, per explicit user decision to move on.

  Also: `WebContentsView`'s popup handling needed `setWindowOpenHandler` to intercept `target=_blank`/`window.open()` navigation (Premier League's own highlights links use this) and redirect the same pane in-place instead of spawning an untracked native window. And since PulseLive's badge CDN (`resources.premierleague.com/premierleague/badges/50/t{id}.png`) turned out to use a **fourth**, unrelated ID scheme from the fixtures API's own `club.id` (confirmed by fetching `t1.png`/`t4.png`/`t7.png` directly — they show Man Utd/Newcastle/Aston Villa, not Arsenal/Chelsea/Everton), crests are sourced from ESPN's team-logo CDN instead (`a.espncdn.com/i/teamlogos/soccer/500/{espnId}.png`), keyed by club name and each ID confirmed directly against ESPN's own team API rather than assumed.

  **Dynamic multi-view grid (2026-09-09).** Panes went from a fixed 2-entry array built once at startup to individually addressable, created/destroyed/swapped at runtime. The core change: every pane now gets a permanent `id` (a monotonic counter, never reused) used for all messaging, decoupled from its position in the `panes` array — previously each pane's array `index` was baked into its own event-handler closures at construction (`createPane`), so removing a pane and shifting positions would have left those closures reporting the wrong slot. Grid *position* is now purely "index in the array at layout time"; identity never changes. A small per-league `LEAGUE_PROVIDERS` dispatch table (`resolve(game) → { url, skipCapable, label }`) replaced the two hand-written `open-game`/`open-epl-match` IPC handlers, so opening/adding/replacing a pane is one generic code path regardless of league — this is also where Champions League will plug in next.

  Two real bugs surfaced building this: (1) `getHomeData`/`getEplHomeData` used to piggyback on `panes[0]`/`panes[1]` purely to run the page-context `fetchViaPage` trick — broke once the grid could start empty. Fixed with dedicated always-hidden utility `WebContentsView`s, one per league family (not one shared view — `footballapi.pulselive.com` checks the request's `Origin` header against `premierleague.com` and rejects a fetch issued from an nba.com-loaded page, confirmed directly rather than assumed). (2) `layoutPanes` computed each row's column width by dividing by the grid's overall column count, not that row's actual pane count — harmless for the old fixed 2-pane case, but a real bug once 3-pane grids were reachable: the lone pane in a half-empty last row got only half the width, leaving a blank gap. Fixed to give a lone last-row pane the full row width, and the renderer's own DOM chrome (labels/controls, previously a plain non-wrapping flex row) switched to CSS Grid for 3-4 panes with row/column math that mirrors `layoutPanes` exactly — the two were laid out independently and had drifted out of sync, which is what "the 3/4-pane grid looks weird" turned out to be.

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

- **v0.3: Home/schedule page — done (2026-09-09).** First real screen beyond the grid, and it surfaced a genuine architecture bug worth understanding.

  **Real data sources validated**, all via page-context fetch (same lesson as Phase 3 — main-process fetch silently hangs against these hosts too):
  - Today's games: `cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json` — official NBA CDN, no key needed. Empty most of this testing (NBA offseason in September), but the shape is right.
  - Full upcoming schedule: `cdn.nba.com/static/json/staticData/scheduleLeagueV2.json` — only covers the *upcoming* season (starts Oct 2026), not historical games.
  - Last completed game fallback: `stats.nba.com/stats/leaguegamefinder?LeagueID=00&Season=2025-26&SeasonType=Playoffs&PlayerOrTeam=T` — gives real historical results; used to find the actual last Finals game (2026-06-13, Knicks beat Spurs 94-90, Game 5) when there's nothing live today. Season string is currently hardcoded (`2025-26`) — will need updating once a new season is underway.
  - Per-game deep link: `nba.com/game/{away}-vs-{home}-{gameId}?watchFullGame` — found by manually navigating to a real game and reading the URL back via the `Cmd+Shift+U` hotkey, not guessed. Confirmed: opens straight into the right game (needs one manual click to actually start playing — normal browser autoplay policy, not a bug).

  **Real architecture bug found and fixed**: the video panes are native `WebContentsView`s, positioned by the main process in absolute window coordinates — a completely separate layer from the renderer's own HTML/CSS. The first implementation only toggled the renderer's `#home`/`#grid` `<div>` visibility via CSS, which did nothing to the native panes underneath — they kept rendering regardless, so the "home page" showed with the grid bleeding through behind it. Fixed by adding an explicit `currentView` state in the main process that gates both pane layout (`hideAllPanes()` vs. the real `layoutPanes()`) and audio muting (no pane gets audio while on the home page) — the renderer's CSS toggle alone was never going to be enough, since it has no visibility into or control over the native view layer at all.

  Favorite-team selection persists to a local JSON file (`app.getPath('userData')/preferences.json`) but isn't wired into any scoring yet — that's v0.7's job once the recommendation engine exists.
