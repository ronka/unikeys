# Plan: PostHog analytics for the app and the landing page

> Date: 2026-08-12
> PostHog project: **unikeys**, id `554415`, org `ronka` (`019ff62f-c20d-0000-06ff-10571faef90d`)
> Public project token: `phc_pUKGXqQXsFSsUeG3qRZrjjzrVP2RF4SF8LfmgyPPvqQs`
> Host: `https://us.i.posthog.com` (US cloud) · UI: `https://us.posthog.com/project/554415`
> Project state at time of writing: `ingested_event: false` — nothing has ever been sent.

## Status — implemented 2026-08-12

Tasks 1–8 and 10 are **done and verified against the live project**. Task 9 is
**closed** (Decision A answered "no"). Task 11 was not taken up.

Decisions taken: **A — no MAS network entitlement.** **B — opt-in consent.**

Dashboards: [landing page](https://us.posthog.com/project/554415/dashboard/1988741) ·
[desktop app](https://us.posthog.com/project/554415/dashboard/1988742)

### What the implementation corrected in this plan

Four things below were written from reading and turned out otherwise when run.
They are corrected in place in the tasks; recorded here because each one would
otherwise be re-derived by the next person.

- **`posthog-node` is externalized, not bundled.** Task 5 predicted electron-vite
  would bundle it because `main: {}` sets no `externalizeDepsPlugin`. It does
  not — `out/main/index.js` contains `require("posthog-node")`. This is fine and
  needs no change: the package is in `dependencies`, so electron-builder packs
  it into the asar. It does mean the dependency is real at runtime rather than
  inlined, which is worth knowing before trimming `dependencies`.
- **`$ip: null` does not suppress IP capture; `'0.0.0.0'` does.** PostHog's
  ingestion fills `$ip` from the request's source address unless the event
  carries a concrete value, and `null` does not count as one. The first two
  verification runs arrived in PostHog carrying a real home IP address. Only a
  placeholder displaces it. This matters because the consent screen promises
  nothing identifying is sent, and an IP identifies a household.
- **posthog-js drops every event from a headless browser.** Its bot filter keys
  off the `HeadlessChrome` user agent and `navigator.webdriver`, so the landing
  page sends nothing under automation until `opt_out_useragent_filter: true` is
  set at runtime. Correct behaviour in production, and a trap for anyone trying
  to smoke-test the page from CI — the page looks broken when it is working.
- **`row_matched.cells_changed` became `needed_winner`.** Counting the cells a
  match writes would have meant a second copy of the table reducer's rule at the
  call site. Which cells a match writes lives in the reducer and nowhere else.

### Verification: 12 of 13 events observed arriving in PostHog

The renderer was driven through real app runs over CDP (`npx electron-vite dev --
--remote-debugging-port=9333`, attached with the same browser tooling used on the
landing page), and every event confirmed by querying the project afterwards.

Observed: `app_launched`, `bindings_imported`, `onboarding_started`,
`onboarding_step_completed` (both `consent` and `pick`), `onboarding_completed`,
`onboarding_dismissed`, `row_matched` (`needed_winner: true`), `save_completed`,
`save_reverted`, `app_toggled`, `analytics_opt_in`, `analytics_opt_out`.

Three properties worth more than the event list, all confirmed by the same runs:

- **Opt-out ordering holds.** `analytics_opt_out` arrives at all, which it only
  can if it is captured before the client is dropped — the exact sequence
  `setEnabled` was written for.
- **Declining is silent.** With consent absent or `false`, `lsof` shows the app
  opening no connection to PostHog whatsoever, and no events arrive.
- **The quit flush works.** Events appear only after a graceful quit, never
  while the app is still open. That is the `before-quit` handler earning its
  keep; without it the whole of a short session would be lost.

**Not observed, and why.** `grant_outcome` and
`onboarding_step_completed{step: 'access'}` both need the native macOS folder
picker, which CDP cannot drive — it is not part of the web contents. The
`row_matched{needed_winner: false}` variant went unobserved too: the row that
came up for matching happened to need a winner. All three are ordinary paths
over verified plumbing, but they deserve one manual pass under a sandboxed
build, where the grant flow is the entire point.

---

## Overview

Connect two surfaces to one PostHog project:

1. **The landing page** (`docs/index.html`, served from GitHub Pages at `https://ronka.github.io/unikeys/`) — pageviews, download-CTA clicks, and interaction with the hero demo table.
2. **The desktop app** (Electron, macOS) — a small, typed, opt-in event set covering launch, onboarding, import, match, save and revert.

The landing page is trivial and unblocked. The app is not, and the plan is shaped around
the two things that actually constrain it:

- **The Mac App Store build cannot reach the network.** `build/entitlements.mas.plist`
  has no `com.apple.security.network.client`. The DMG build (`entitlements.mac.plist`,
  Hardened Runtime) needs no change — Hardened Runtime does not gate outbound network.
  So **DMG analytics ship now; MAS is a separate, decision-gated task** (Task 9). If that
  decision is "no", the plan still completes — the App Store cohort is simply invisible,
  which is a legitimate outcome but must be a chosen one, not a discovered one.
- **This app reads other people's config files.** Its whole pitch is "opening unikeys
  writes nothing." Analytics that leaked a config path, a vault name or a chord the user
  typed would be a worse breach of that promise than any write. The property allowlist
  (Task 3) is therefore load-bearing, not hygiene.

---

## Two decisions to make before Task 9

These change scope. Everything in Tasks 1–8 and 10 proceeds either way.

### Decision A — does the MAS build get `com.apple.security.network.client`?

**Recommendation: no, not for analytics alone.** `entitlements.mas.plist` states its own
rule in its header: *"Nothing here is present for convenience. Every key is one the app
stops working without."* Analytics is exactly convenience. Adding the key also drags in:

- an App Store Connect privacy-label declaration (Product Interaction / Usage Data),
- a **privacy policy URL**, which does not exist — `docs/` contains only `index.html`,
- an App Review question you now have to answer about why a keybinding editor phones home.

The cost of "no": zero visibility into the App Store cohort, including the single most
useful question ("which of the thirteen apps do people actually use"). If that cohort
turns out to matter more than the principle, Task 9 is written and ready.

### Decision B — is app analytics opt-in or opt-out?

**Recommendation: opt-in**, as a step in the existing `OnboardingWizard`. It matches the
posture of the rest of this codebase and of `MAC-APP-STORE.md`.

State the cost honestly: on a developer tool, opt-in plausibly halves the sample, and it
halves it *non-randomly* — the privacy-conscious developer who avoids telemetry is not a
random draw from the user base, and they are disproportionately the kind of person who
uses Zed and Ghostty. The app-popularity numbers will be biased toward the mainstream and
should never be quoted as if they were not.

Opt-out would give a fuller picture and is defensible for anonymous, no-content events —
but it is not what this codebase would do.

---

## Design constraints

These are decisions, not preferences. Each has a reason specific to this repo.

**`posthog-node` in the main process, never `posthog-js` in the renderer.**
`posthog-js` autocapture records DOM text, and this renderer's DOM contains app names,
chord values and config paths (`SettingsPage`, `AppsPage`, the keys table). Even with
autocapture disabled it is one config change away from capturing all of it. Main-process
capture also means: no CSP change, no `localStorage`, one `distinct_id` owned by one
process, and one chokepoint for the allowlist. **This is also why project-wide session
replay is safe to leave on** (see Task 1) — the app cannot produce a recording if the
recorder is never loaded into it.

**One typed event contract in `src/shared/`.** Event names and property types are a
discriminated union, so no call site can pass a free-form string and no property can be
added without editing the contract. This is the same discipline as `src/shared/ipc.ts`.

**Never sent, at any severity:** absolute paths, `configPath` overrides, backup
directory, Obsidian vault names, config file contents, user-authored chord strings,
machine name, username, IP-derived geo beyond PostHog's own default.
**Safe to send:** `AppId` (fixed enum, shipped), catalogue action ids (shipped data),
counts, `AppHealth` values, outcome enums, channel (`dmg` | `mas`), app version, macOS
major version.

**The token is public and belongs hardcoded in both surfaces.** It is a project *write*
key, not a secret. Do not build env-var plumbing: GitHub Pages has no build step to
substitute one, and `.env` is excluded from the asar by `electron-builder.yml` anyway.

**`distinctId` is a random UUID in the existing store.** Additive `analytics` field in
`unikeys-store.json`, following the `grants` / `onboardingCompleted` precedent — **no
`schemaVersion` bump**. Not the machine UUID, not the hostname, nothing derivable back to
a person or a device.

**Landing-page → app identity stitching is impossible. Do not attempt it.** The download
CTA leaves to GitHub Releases; no query parameter survives into a downloaded DMG, and
there is no install-time callback. The two funnels are joined only at the aggregate level
(daily download-clicks vs daily first-launches). Written here explicitly so nobody builds
an insight that silently cannot work.

**GitHub Pages cannot reverse-proxy**, so landing-page ingestion goes direct to
`us.i.posthog.com` and ad blockers will eat a slice of it. Accepted; not a workstream.
Treat landing-page absolute numbers as a floor, and trust the ratios more than the counts.

---

## Tasks

### Task 1: Project hygiene and an end-to-end ingestion smoke test

- **Type**: Agent-executable (PostHog MCP) + one manual browser check
- **Blocked by**: None

Because `ingested_event: false`, nothing about this project's ingestion is proven. Prove
it before building anything on top of it.

#### What to build

- Confirm and record the project's current risky defaults, all verified via MCP `project-get`:
  - `session_recording_opt_in: true` — **leave on**, but only because the decision above
    keeps `posthog-js` out of the Electron renderer entirely. If that decision is ever
    reversed, replay must be turned off in the same change. Note this in the code comment
    at the app's PostHog init site.
  - `autocapture_exceptions_opt_in: true` and `capture_console_log_opt_in: true` — both
    apply to `posthog-js` only, so landing-page only. Harmless there.
  - `heatmaps_opt_in: true`, `capture_dead_clicks: true` — fine, landing page only.
- Send one throwaway event from a scratch Node script using the project token, confirm it
  lands, then delete nothing (the event definition is harmless and proves the path).

#### Acceptance criteria

- [ ] A scratch `posthog-node` script sends `smoke_test` and it is visible in the
      PostHog activity view within 60s
- [ ] `project-get` re-read confirms `ingested_event: true`
- [ ] The three replay/autocapture settings above are recorded in this plan's margin as
      "checked, left as-is, reason: renderer never loads posthog-js"

---

### Task 2: Landing page — snippet, pageview, and outbound CTA clicks

- **Type**: AFK
- **Blocked by**: Task 1

#### What to build

- `docs/index.html`: insert the standard PostHog snippet immediately before `</head>`
  (currently **line 600**), with `api_host: 'https://us.i.posthog.com'` and
  `defaults: '2025-05-24'`. Autocapture stays at its default (on) — this is a static
  marketing page with no user data in the DOM.
- Explicit outbound-click events, because **every download CTA leaves the origin** and
  autocapture alone will not reliably record a navigation away:
  - `download_clicked` — the three DMG links at lines **612** (nav), **633** (hero),
    **841** (download section). Property `location: 'nav' | 'hero' | 'download'` plus
    `version: '1.0.0'`.
  - `outbound_clicked` — the secondary offsite links: **636** (read the source),
    **639** (all releases), **868** (fixtures caveat), **879–882** (footer: source,
    issues, releases, author). Properties `location`, `href`.
- Implement as one delegated listener rather than seven inline handlers, and use
  `posthog.capture(..., { send_instantly: true })` so the event is not lost to the
  navigation.

#### Acceptance criteria

- [ ] Loading the page locally with the snippet produces a `$pageview` in PostHog
- [ ] Clicking each of the three download CTAs produces exactly one `download_clicked`
      with the correct `location`, and the download still starts
- [ ] Clicking a footer link produces `outbound_clicked` and still navigates
- [ ] No console errors with an ad blocker disabled; page still renders and the demo
      still works with an ad blocker **enabled** (analytics failing must never break the page)

---

### Task 3: Landing page — hero demo interaction events

- **Type**: AFK
- **Blocked by**: Task 2

The interactive table is the highest-signal engagement on the page and already has
JavaScript to hang off — the existing `<script>` at **lines 886–1008**, with `#rows`,
`#count`, `#chip` and `#reset`.

#### What to build

Inside the existing script, no restructuring:

- `demo_match_clicked` in the `btn.addEventListener('click', ...)` handler (~line 971) —
  properties `action_id` (the shipped `row.id`, safe), and `matched_count` (how many rows
  are matched *after* this click, 1–5).
- `demo_all_matched` — fired once from `updateHead()` when `open === 0`, guarded by a
  module-level flag so a re-render cannot double-fire it. This is the "understood the
  product" signal.
- `demo_reset_clicked` in the `#reset` handler (~line 998).

#### Acceptance criteria

- [ ] Matching one row fires exactly one `demo_match_clicked` with the right `action_id`
- [ ] Matching all five fires `demo_all_matched` exactly once
- [ ] Reset then re-matching all five fires `demo_all_matched` a second time (flag is
      cleared on reset) — decide and assert one behaviour; the flag must not leave the
      event permanently dead for the session
- [ ] Rows still render, match, and reset exactly as before

---

### Task 4: The shared event contract

- **Type**: AFK
- **Blocked by**: None (can run parallel to Tasks 2–3)

#### What to build

New `src/shared/analytics.ts` — pure, no Electron, no `fs`, testable like every other
`src/shared/` module:

- `AnalyticsEvent`: a discriminated union of `{ name, properties }` pairs. Proposed set:
  - `app_launched` — `channel`, `app_version`, `os_version`, `sandboxed`, `apps_enabled_count`
  - `onboarding_started` / `onboarding_step_completed` (`step`) / `onboarding_completed`
    (`apps_selected_count`, `apps_granted_count`) / `onboarding_dismissed` (`at_step`)
  - `grant_outcome` — `app`, `outcome` (the existing `GrantOutcome` discriminant)
  - `bindings_imported` — `apps_read`, `apps_failed`, `rows_total`, `rows_diverging`
  - `row_matched` — `action_id`, `cells_changed`
  - `save_completed` — `apps_written`, `apps_failed`, `bindings_written`,
    `bindings_skipped`, `bindings_dropped`
  - `save_reverted` — `apps_count`
  - `app_toggled` — `app`, `enabled`
  - `analytics_opt_in` / `analytics_opt_out`
- A doc comment at the top stating the never-send list from the constraints section, so
  the rule lives next to the type that enforces it.
- No property type is `string` where an enum will do. `action_id` is the one free-ish
  field and is constrained to catalogue ids.

#### Acceptance criteria

- [ ] `npm run typecheck` passes; a deliberate `properties: { path: '/Users/...' }` fails
      to compile (assert this with a `@ts-expect-error` test case)
- [ ] New `src/shared/analytics.test.ts` asserts every event name is unique and every
      declared property is on the allowlist

---

### Task 5: Main-process client, consent gate, and distinct id

- **Type**: AFK
- **Blocked by**: Task 4

#### What to build

- `package.json`: add `posthog-node`. `electron.vite.config.ts` has `main: {}` — no
  `externalizeDepsPlugin` — so it will be **bundled** into `out/main/index.js`.
  `posthog-node` is pure JS with no native modules, so this works; verify it rather than
  assume it (acceptance criterion below).
- `src/shared/store/types.ts`: additive `analytics: { distinctId: string; enabled: boolean | null }`.
  `null` = not yet asked. `createEmptyStore()` sets `{ distinctId: <uuid>, enabled: null }`;
  `deserializeStore()` mints a `distinctId` when absent and defaults `enabled` per
  Decision B. **No `schemaVersion` bump** — same precedent as `grants`.
- New `src/main/analytics.ts`:
  - Lazily constructs the `PostHog` client **only after** consent is `true`. Not
    constructed-then-disabled: not constructed at all, so there is no client to leak.
  - `capture(event: AnalyticsEvent)` — the only exported capture path.
  - A `flushAt` / `flushInterval` tuned for a desktop app that may be open for days.
  - `shutdown()` awaited on `app.on('before-quit')` in `src/main/index.ts`. **Without
    this the final session's events are lost** — the single most commonly missed step
    with `posthog-node`.
  - Hard no-op when `process.env.UNIKEYS_SIMULATE_SANDBOX` is set or in dev, so
    `npm run dev` never pollutes production data. Provide an env override to test
    ingestion deliberately.

#### Acceptance criteria

- [ ] `npm run build:mac` produces an app that launches; `out/main/index.js` contains the
      bundled client (grep for a posthog string) and no `require('posthog-node')` escapes
      to a missing `node_modules`
- [ ] With `enabled: null` or `false`, **zero** network requests to `us.i.posthog.com` —
      verified with Little Snitch or `lsof`/proxy, not by reading the code. No `$identify` either.
- [ ] With `enabled: true`, launching and quitting produces `app_launched` in PostHog —
      proving `shutdown()` actually flushes
- [ ] `npm run dev` produces no events
- [ ] `unikeys-store.json` written by the current build (no `analytics` key) loads without
      error and gains a `distinctId` on next save
- [ ] Airplane mode: app launches, imports and saves normally with no hang and no error
      dialog — analytics failure must be silent and non-blocking

---

### Task 6: IPC surface

- **Type**: AFK
- **Blocked by**: Task 5

#### What to build

- `src/shared/ipc.ts`: add `track(event: AnalyticsEvent): Promise<void>` and
  `setAnalyticsEnabled(enabled: boolean): Promise<void>` to `UnikeysApi` (~line 322),
  documented in the same register as the neighbouring methods.
- `src/main/ipc.ts` + `src/preload/index.ts`: wire both through. `track` is
  fire-and-forget from the renderer's perspective and must never reject into a call site.

#### Acceptance criteria

- [ ] `npm run typecheck` passes across node, web and test configs
- [ ] Calling `window.api.track(...)` with consent off is a silent no-op, not a throw
- [ ] The renderer cannot import `posthog-node` (it is main-only); assert by grep in review

---

### Task 7: Renderer call sites

- **Type**: AFK
- **Blocked by**: Task 6

#### What to build

Emit from the existing wiring in `src/renderer/src/App.tsx`, all of which already exists:

- `app_launched` — the startup effect (~line 130), after `load()` resolves.
- Onboarding funnel — `OnboardingWizard`'s existing `onComplete` / `onDismiss` props
  (rendered at ~line 525) and its internal step transitions.
- `grant_outcome` — the shared grant handler (~line 261), which both `AppsPage` and the
  wizard already call, so one call site covers both.
- `bindings_imported` — after the import dispatch (~line 174) and in
  `handleOnboardingReimport` (~line 304).
- `row_matched` — the `matchRow` dispatch (~line 329).
- `save_completed` — the write handler (~line 370), from the existing `WriteResult`.
- `save_reverted` — the revert path in `HistoryPage`'s handler.
- `app_toggled` — the shared enable handler (~line 321).

#### Acceptance criteria

- [ ] A full manual run — fresh store → onboarding → grant two apps → import → match a
      row → save → revert — produces the full expected event sequence in PostHog, in order
- [ ] Every property in every captured event is on the allowlist, verified by reading the
      actual JSON in PostHog's event view, not by reading the code
- [ ] Specifically confirmed absent from all payloads: any `/Users/` string, any vault
      name, any chord value
- [ ] `npm test` and `npm run typecheck` pass

---

### Task 8: Consent UI

- **Type**: AFK
- **Blocked by**: Task 6 (parallel with Task 7)

#### What to build

- A consent step in `src/renderer/src/components/OnboardingWizard.tsx`, in the existing
  step sequence. Plain language: what is sent, what is never sent, that it is anonymous,
  that it can be turned off at any time.
- A toggle in `src/renderer/src/pages/SettingsPage.tsx` using the existing `Section`
  pattern (the file already has one for "Onboarding").
- Opting out calls `setAnalyticsEnabled(false)`, which shuts the client down and drops it.
- `analytics_opt_out` is captured **before** the client is torn down — the last event, then
  silence.

#### Acceptance criteria

- [ ] Fresh store → wizard shows the consent step; declining sends **nothing at all**,
      including no `$identify` and no `app_launched`
- [ ] Accepting, then relaunching, sends `app_launched` without asking again
- [ ] Settings toggle off → no further events; toggle back on → events resume with the
      **same** `distinctId` (so the person is not fragmented)
- [ ] Replaying onboarding from Settings does not re-ask for consent if already answered
- [ ] The wizard's existing acceptance criteria from `first-run-onboarding-wizard.md` still
      hold — in particular ⌘B still blocked, and quit-mid-wizard still reappears

---

### Task 9: Mac App Store branch — **gated on Decision A**

- **Type**: Manual + AFK
- **Blocked by**: Decision A = yes. **If no, close this task with the reason recorded and stop.**

#### What to build

- `build/entitlements.mas.plist`: add `com.apple.security.network.client`, with a comment
  in the file's established style explaining why it is present — the file's header rule
  demands one.
- A privacy policy page. `docs/` has only `index.html`; add `docs/privacy.html` in the
  same visual language, linked from the footer (lines 879–882). App Store Connect requires
  a reachable URL.
- App Store Connect privacy labels: Product Interaction / Usage Data, not linked to
  identity, not used for tracking.
- A line in `MAC-APP-STORE.md`, which is where this repo already records its App Store
  reasoning.
- `channel` property resolves to `'mas'` — derived from the sandbox check that already
  exists, not from a build-time flag.

#### Acceptance criteria

- [ ] `npm run build:mas` produces a `.pkg` that installs and launches
- [ ] The MAS build with consent on reaches `us.i.posthog.com` and events arrive with
      `channel: 'mas'`
- [ ] With consent off, the sandboxed build makes no network connection
- [ ] Privacy policy URL is live on GitHub Pages before submission
- [ ] Grants, bookmarks and file writes still work — the new entitlement must not have
      disturbed the sandbox setup

---

### Task 10: Insights and dashboard

- **Type**: Agent-executable via PostHog MCP
- **Blocked by**: Tasks 3 and 7 (needs real events so definitions resolve)

#### What to build

Two dashboards, deliberately separate, because the funnels **cannot** be joined
(see constraints):

**Landing page**
- Pageviews and unique visitors over time
- Funnel: `$pageview` → `demo_match_clicked` → `download_clicked`
- `download_clicked` broken down by `location` — answers "is the hero CTA or the footer
  CTA doing the work"
- `demo_all_matched` rate as a share of pageviews

**App**
- `app_launched` daily/weekly actives, broken down by `channel`
- Onboarding funnel: `onboarding_started` → `onboarding_step_completed` →
  `onboarding_completed`, with drop-off per step
- `app_toggled` and `grant_outcome` broken down by `app` — **the headline question:
  which of the thirteen apps do people actually use.** Annotate the insight with the
  opt-in sampling bias from Decision B so the number is never read naively.
- `save_completed` trend; `bindings_dropped > 0` as a quality alarm
- Retention on `app_launched`

Aggregate-only cross-surface tile: daily `download_clicked` vs daily first-time
`app_launched`, with a description stating that these are two populations and the ratio
is indicative, not a conversion rate.

#### Acceptance criteria

- [ ] Both dashboards exist in project 554415 and render without "event not found"
- [ ] Every insight returns non-empty data from the manual runs in Tasks 3 and 7
- [ ] Event definitions have descriptions, so the taxonomy is legible in six months
- [ ] The cross-surface tile carries its caveat in its description field

---

### Task 11: Error tracking — **optional, gated**

- **Type**: AFK
- **Blocked by**: Task 5. Only if wanted.

Main-process stack traces carry absolute paths including `$HOME` and, for this app,
frequently the config paths it was reading when it failed. That is precisely the data the
allowlist exists to keep out.

If wanted, it requires a `beforeSend` hook that scrubs `$HOME` and every known config root
out of frame paths and messages before send — plus a test proving the scrub, using a
synthetic stack containing a `/Users/` path. Without that scrub, do not enable it.

#### Acceptance criteria

- [ ] A deliberately thrown error in main arrives in PostHog with no `/Users/<name>`
      substring anywhere in the payload
- [ ] `src/main/analytics.test.ts` covers the scrub with a synthetic stack

---

## Sequencing

```
Task 1 (smoke test)
  ├── Task 2 → Task 3            landing page, shippable on its own
  └── Task 4 → Task 5 → Task 6 ──┬── Task 7   app call sites
                                 └── Task 8   consent UI
                                       ↓
                        Task 9 (gated on Decision A)
                        Task 10 (needs real events from 3 + 7)
                        Task 11 (optional)
```

Tasks 2–3 can ship independently of the entire app workstream and are worth landing first:
they are low-risk, and they start collecting the download-funnel data that has no
retroactive fix.
