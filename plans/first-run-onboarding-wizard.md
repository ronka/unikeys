# Plan: First-run onboarding wizard

> Generated from: /Users/ronkantor/.claude/plans/lively-purring-puppy.md (planning conversation)
> Date: 2026-08-12

## Overview

In the Mac App Store (sandboxed) build, all 13 supported apps start as "Needs access" and nothing on first run guides the user through granting a config folder per app or locating keybinding files. This plan adds a multi-step onboarding modal wizard — pick your apps → grant access → re-import + results — shown only on first mount, gated by a new additive `onboardingCompleted` store field (NOT `firstRunCompleted`, which is set on every launch by the import dispatch), and replayable from Settings for debugging. The DMG build gets the same wizard with the access step reduced to apps whose config can't be auto-resolved. No `src/main/` or `src/preload/` changes are needed — the existing `requestGrant`, `chooseConfigPath`, `importBindings`, `refreshStatuses`, and `persistStore` IPC surface covers everything.

Key design constraints (see the planning doc for full detail):

- Under the sandbox, unikeys cannot detect installed apps before a grant, so the wizard opens with an app picker seeded from `enabled` flags (`seedUnknownApps` already disables not-installed apps on a fresh store).
- The gate must be read from the raw `LoadResult` before any dispatch (`App.tsx` startup effect), because the every-launch import forces `firstRunCompleted: true`.
- `deserializeStore` derives `onboardingCompleted` for legacy stores: key absent + `firstRunCompleted: true` → treated as onboarded (existing users don't see onboarding on upgrade); new builds always serialize the key explicitly, so quit-mid-wizard reappears correctly.
- Never stack two Radix dialogs — the wizard reuses the exported `Modal` and an extracted `ImportSummaryBody`, not the `ImportSummaryPanel` itself.

---

## Tasks

### Task 1: Onboarding gate, wizard shell, and Settings replay

Status: done (code + tests; live-run criteria verified in Task 5)

- **Type**: AFK
- **Blocked by**: None - can start immediately

#### What to build

The complete gating skeleton, end to end: store field → reducer action → App wiring → a minimal wizard modal → Settings replay button. The wizard body is a placeholder (title, short explanatory text, a Done button); the real steps land in Tasks 2–4.

- `src/shared/store/types.ts`: add `onboardingCompleted: boolean` to `Store`; `createEmptyStore()` sets `false`; `deserializeStore()` adds the legacy derivation (`data.onboardingCompleted === true || (data.onboardingCompleted === undefined && data.firstRunCompleted === true)`), with a comment explaining why. No `schemaVersion` bump (the `grants` precedent).
- `src/shared/table/reducer.ts`: add `{ type: 'setOnboardingCompleted'; completed: boolean }` action — plain store patch; persistence is free via the existing persist effect.
- `src/renderer/src/components/Panels.tsx`: export the module-private `Modal`.
- New `src/renderer/src/components/OnboardingWizard.tsx`: shell rendering inside `Modal` with `onComplete` / `onDismiss` props.
- `src/renderer/src/App.tsx`: add `'onboarding'` to the `Overlay` union; in the startup effect capture `needsOnboarding = !result.store.onboardingCompleted` before dispatch; after the import dispatch, `needsOnboarding` → open the wizard (and set `importResult`), `else if (firstRun)` → legacy summary path. Render the wizard in the overlay block; `onComplete` dispatches `setOnboardingCompleted(true)` and closes; `onDismiss` closes without completing.
- `src/renderer/src/pages/SettingsPage.tsx`: new "Onboarding" `Section` with a "Replay onboarding" outline button; `onReplayOnboarding` in App dispatches `setOnboardingCompleted(false)` and opens the overlay.

#### Acceptance criteria

- [x] Fresh store (`rm ~/Library/Application Support/unikeys/unikeys-store.json`) + `npm run dev` → wizard shell opens; the old "Imported your keybindings" modal does NOT appear
- [x] Done → relaunch → no wizard; store JSON contains `"onboardingCompleted": true`
- [x] Quit (or Esc) with the wizard open → relaunch → wizard reappears, even though `firstRunCompleted` is already `true` on disk (the trap test)
- [x] Store written by the current build (has `firstRunCompleted: true`, no `onboardingCompleted` key) → no wizard on launch (upgrade path)
- [x] Settings → Replay onboarding → wizard reopens; Done closes it; relaunch → no wizard
- [x] ⌘B is blocked while the wizard is up (existing `shortcutBlocked` covers any non-`'none'` overlay)
- [x] New vitest cases pass: `types.test.ts` (fresh → false; legacy no-key + firstRun → true; explicit false + firstRun → false; round-trip) and `reducer.test.ts` (toggle leaves `pending`/`chords`/`apps` untouched)

#### User stories addressed

- Onboarding shows only on first mount
- Onboarding can be restarted from Settings for easy debugging

---

### Task 2: "Pick your apps" step

Status: done (code; live-run criteria verified in Task 5)

- **Type**: AFK
- **Blocked by**: Task 1

#### What to build

The wizard's first real step: a checklist of all 13 apps (grouped by category, like AppsPage), each row showing the app name plus a muted "not installed" tag from `statuses`, seeded from current `enabled` flags. Footer: **Continue** (disabled at zero selected) and a quiet **Skip setup** text button that completes onboarding outright. Continue diffs the selection against `apps[app].enabled` and calls `onSetAppEnabled` per change (App's handler clears `appFilter` when disabling the filtered app, same guard as AppsPage `onToggle`), then advances. Until Task 3 exists, Continue can advance straight to the placeholder/final step.

#### Acceptance criteria

- [x] Fresh store → checklist defaults to the machine's installed apps (via `seedUnknownApps`)
- [x] Not-installed apps carry a muted tag but remain selectable
- [x] Unchecking an app then continuing → its column disappears from the Keys table and its Apps card shows "Turned off"
- [x] Continue is disabled with zero apps selected
- [x] "Skip setup" completes onboarding (no wizard on relaunch)
- [x] Replay from Settings seeds the checklist from the current `enabled` flags

#### User stories addressed

- Users choose which apps they use, decluttering the table
- Works in both sandboxed and DMG builds

---

### Task 3: Access walkthrough step

Status: done (code + tests; live-run criteria verified in Task 5)

- **Type**: AFK
- **Blocked by**: Task 2

#### What to build

The step that resolves permissions and config locations, driven by a pure, tested queue helper.

- New `src/shared/onboarding.ts`: `accessQueue(statuses, selected, sandboxed): AppId[]` — sandboxed: selected apps with health `'grant-required' | 'config-path-required' | 'config-not-found'`; DMG: only `'config-path-required' | 'config-not-found'`; ordered by `APP_IDS`. New `src/shared/onboarding.test.ts`.
- `src/renderer/src/App.tsx`: hoist the inline AppsPage `onGrant` (dispatch `grantApp` + `setAppConfigPath`, maintain `grantErrors`) into `handleGrant(app, at?): Promise<GrantOutcome>` that returns the outcome; same for `handleChoosePath(app): Promise<string | null>`. AppsPage keeps identical behavior via thin wrappers.
- Wizard: on Continue from the picker, compute and **freeze** the queue (live statuses refresh as grants land and would reshuffle a derived queue); empty queue → skip straight to results. Step UI: "App X of N" progress, current app name + `status.message`, primary button "Grant access…" (sandbox, `onGrant(app, status.grantPath)`) or "Choose config…" (DMG, `onChoosePath(app)`), per-app **Skip**. Outcomes: ok → mark done, advance; cancelled → stay silently; error (e.g. `grantMismatch`) → inline `stepError`, stay.

#### Acceptance criteria

- [x] `npm run dev` (simulated sandbox), fresh store: access step walks every selected app one native panel at a time with a correct X-of-N counter
- [x] Picking a wrong folder shows the mismatch message inline and stays on that app; Cancel stays silently; Skip advances
- [x] Granting updates the store (grant persists; Apps page card clears to healthy without extra action)
- [x] `npm run dev:dmg`, fresh store: no grant panels ever; step prompts only for `config-path-required` / `config-not-found` apps, or is skipped entirely when nothing needs input
- [x] Replay with grants already in place → queue is short or empty (pick → results directly)
- [x] `onboarding.test.ts` covers sandbox vs DMG filtering, selection filtering, `APP_IDS` ordering, empty result
- [ ] AppsPage grant/choose-path behavior is unchanged

#### User stories addressed

- Users are guided through granting folder access under App Sandbox
- Users are guided to locate keybinding files that can't be auto-resolved
- DMG build adapts (grants don't exist there)

---

### Task 4: Results step with re-import

Status: done (code + full typecheck/test/lint; live-run criteria verified in Task 5)

- **Type**: AFK
- **Blocked by**: Task 3

#### What to build

The wizard's payoff: after grants, re-import and show the user their keys actually arrived.

- `src/renderer/src/components/Panels.tsx`: extract `ImportSummaryPanel`'s body (stat grid + `appsFailed` list) into an exported `ImportSummaryBody({ summary, result })`; the legacy panel renders identically via `Modal` + body.
- `src/renderer/src/App.tsx`: extract the startup import's chord-mapping block into `mapImported(imported, store)` (the `isCellUnseen` filter + `parseCanonical` + origin mapping, used by both call sites); add `handleOnboardingReimport()` — `window.unikeys.importBindings(state.store)` → `setStatuses`, dispatch `importBindings` with `mapImported(imported, state.store)` (current store, so already-imported cells are untouched; no `markFirstRunCompleted`), `setImportResult(imported)`.
- Wizard: entering the results step runs `onReimport()` exactly once (useRef guard for StrictMode); shows "Reading your keybindings…" while importing, then `ImportSummaryBody` plus, when apps were skipped, a muted "N apps still need access — you can grant it any time from the Apps page." Footer: **Done** → complete.

#### Acceptance criteria

- [x] After granting in the access step, the results step shows non-zero apps-read / action counts reflecting the freshly granted apps
- [x] Skipped apps produce the muted still-need-access note; they remain visible on the Apps page as "Needs access"
- [x] The legacy `ImportSummaryPanel` (reachable via a hand-edited store: `onboardingCompleted: true`, `firstRunCompleted: false`) renders exactly as before the extraction
- [x] Re-import never overwrites cells the user has set or cleared (`origin: 'user'` untouched; `isCellUnseen` filter against current store)
- [x] Results step's import runs once despite StrictMode double-invocation
- [x] `npm run typecheck && npm run test && npm run lint` pass (note: `npm run lint` was failing before this work on generated `app-store-screenshots/` and `.agents/` files; those directories are now in eslint's ignores)

#### User stories addressed

- First-run import summary is folded into onboarding (no stacked modals)
- Users see their keybindings arrive as the wizard's final step

---

### Task 5: End-to-end QA pass

Status: done (verified by hand, 2026-08-12)

- **Type**: HITL
- **Blocked by**: Task 4

#### What to build

Nothing new — a human-run verification matrix over both build flavors, resetting state between runs (`rm ~/Library/Application Support/unikeys/unikeys-store.json` while the app is quit).

#### Acceptance criteria

- [x] Simulated sandbox (`npm run dev`) fresh-store run: full wizard flow, grants land, results correct, Done persists
- [x] DMG (`npm run dev:dmg`) fresh-store run: access step reduced or skipped, no grant panels
- [x] Upgrade path: legacy store without the `onboardingCompleted` key → no wizard
- [x] Quit-mid-wizard → wizard reappears next launch; already-made grants/toggles are kept and the queue is shorter
- [x] Replay from Settings works after a completed run, with pending edits present (pending edits untouched)
- [x] Visual pass: wizard matches the app's modal look in light and dark themes

#### User stories addressed

- All of the above, verified end to end

---
