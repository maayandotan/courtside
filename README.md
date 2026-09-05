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

Pipeline:

1. **Screen capture, not DOM access.** DRM blocks direct pixel reads from the `<video>` element via canvas. Instead, capture the composited screen/window output using OS-level APIs — macOS `ScreenCaptureKit` (Phase 1 target platform is macOS only; Windows can be added later).
2. **Hidden scan.** Seek the video in a background/off-screen view while the visible pane keeps showing the last known-safe position. Only once a target quarter is found does the seek get applied to the visible player.
3. **Binary search over the timeline.** Jump to the midpoint, screenshot, classify (which quarter/period is shown), then jump forward/back by half the remaining range — roughly 6–8 probes instead of dozens of linear steps.
4. **Detection model — start simple, escalate only if needed:**
   - Template matching (OpenCV `matchTemplate`) on the known screen region for the quarter/period graphic.
   - OCR fallback (Tesseract or EasyOCR) if template matching proves unreliable.
   - Fine-tuned lightweight object detector (small YOLO) only if the above fail across enough real broadcasts. Likely unnecessary for v1.
   - **Hard rule, enforced in code:** the model only ever reads the quarter/period indicator region. It never processes or logs the score-digit region, even accidentally within a wider crop.
5. **Confidence/fallback handling:** if the detector isn't confident, scan more conservatively (narrower binary search step) rather than guess.

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
- **Phase 2 — Second service + 2-pane concurrent.** Add DAZN as a second independent view. Build the 2-pane grid, focus-switching (click to focus, audio follows). Validate resource usage on target hardware. Milestone: two live games side by side, instant focus switching, no reload.
- **Phase 3 — Spoiler-safe skip (v1: template matching).** OS-level screen capture scoped to the focused pane. Hidden-scan mechanism (off-screen view seeking ahead). Binary search seek logic. Template-match against reference screenshots. Hard-code the crop region to exclude score digits at the code level. Milestone: click "skip to Q4," scan is invisible, lands correctly, score never rendered during the scan.
- **Phase 4 — Hide-scores toggle + third service.** Add the third service (name TBD — "STING" was a placeholder/garbled name from planning, filtered to sports content only). Build the per-pane hide-scores toggle. Milestone: three services embedded, toggle works per-pane independently.
- **Phase 5 — 4-pane grid + polish.** Extend grid to 4-up, re-validate resource usage. Empty-pane "add a game" state, loading/error states throughout. Real budgeted visual polish pass. Milestone: 4 concurrent games, clean visual polish matching design mockups.
- **Phase 6 — Schedule data + highlights (stretch).** TheSportsDB or API-Football integration. YouTube Data API highlight search per followed team. Blackout-awareness surfacing (informational only). Milestone: a "what's on tonight for my teams" view, with highlight reels for games not watched live.

## 6. Deliberate scope decisions (state these explicitly in any writeup/interview)

- Skip feature runs on one focused pane only — a performance tradeoff, not an oversight.
- No attempt to bypass blackouts or merge accounts/credentials across services — each embedded session is a normal, independent login.
- No scraping of private/unofficial APIs (365Scores) — legitimate free alternatives used instead.
- CV component is applied/engineering-scoped, not a from-scratch model — an honest and hireable framing for general SWE roles.
- Apple TV is out of scope — tvOS doesn't permit the screen capture / browser embedding this relies on. Desktop-only by necessity.

## 7. Tech stack summary

- Shell: Electron via [castlabs/electron-releases](https://github.com/castlabs/electron-releases) (`WebContentsView`-based multi-session embedding, Widevine CDM support)
- CV: OpenCV (template matching primary), Tesseract/EasyOCR (fallback), optionally a lightweight fine-tuned detector later
- Screen capture: macOS `ScreenCaptureKit` (Phase 1); Windows `Windows.Graphics.Capture` if cross-platform is needed later
- Data sources: YouTube Data API v3 (highlights), TheSportsDB or API-Football (schedule/scores)
- Starting scope: basketball (NBA — League Pass, third service TBD) and soccer (Premier League — DAZN)

## Status

- **Phase 1: DRM validated, core milestone met.** Scaffold created (Electron + `WebContentsView`, single pane loading `nba.com/watch`). Confirmed end-to-end: a VMP-signed, packaged build plays real League Pass content with working DRM. Remaining for Phase 1: proper macOS code signing for a shippable build, app icon, and shell UI polish (currently a bare header).

### Build & test workflow (until this is scripted)

```bash
npm run pack                                   # package into dist/mac-arm64/CourtSide.app
.evs-venv/bin/evs-vmp sign-pkg dist/mac-arm64  # VMP-sign (required for real DRM playback)
open dist/mac-arm64/CourtSide.app
```

EVS account credentials/tokens live in `~/.config/evs`, outside the repo. `.evs-venv/` (the local Python tool for `evs-vmp`) and `dist/` are gitignored.
