# Plan: Getting unikeys onto the Mac App Store

> Generated from: MAC-APP-STORE.md
> Date: 2026-08-12

## Overview

Make unikeys submittable to the Mac App Store by rebuilding all file access to work
under App Sandbox. Every hardcoded home-directory path becomes a user-granted directory
persisted as a security-scoped bookmark, `/Applications` scanning becomes bundle-ID
lookup, and the build gains a `mas` target with its own entitlements, certificates, and
provisioning profile. The blast radius is essentially two files (`src/main/config-files.ts`
and `src/main/apps-service.ts`) plus build configuration; adapters, reducers, backups,
store/history files, and the renderer need no changes.

**Decision made (2026-08-12): the directory-picker grant flow is acceptable.** The PRD's
Phase 0 go/no-go gate is resolved — App Store submission is committed, and no task is
conditional on a UX decision anymore. Task 1 remains as a purely technical spike; tasks
5 and 7 can start immediately in parallel.

**Reaffirmed (2026-08-12), after the costs were spelled out:** the App Store is the
target, not a maybe. The costs accepted are up to 13 folder grants on a first run, an
extra grant for anyone whose config is symlinked into a dotfiles repo, no self-update,
and review risk on an app that edits other apps' files. The dmg stays buildable and
shippable throughout — this is an additional distribution channel, not a replacement.

Because the store is now the target rather than an option, `npm run dev` defaults to the
sandboxed behaviour and `npm run dev:dmg` is the opt-out. Task 7 is the critical path:
no sandboxed build can launch without those certificates, so nothing downstream of it
can be tested at all.

---

## Running it in development

```bash
npm run dev        # behaves like the App Store build — sandboxed, grants required
npm run dev:dmg    # behaves like the dmg build — no sandbox, no grants
```

The App Store build is the target, so the default run matches it. `npm run dev` sets
`UNIKEYS_SIMULATE_SANDBOX=1`, which makes `isSandboxed()` return true and puts the whole
flow in reach — the "Needs access" state, the "Grant access…" button, the picker and the
folder it opens at, the validation messages, and the JetBrains parent-directory rule.
`npm run dev:dmg` leaves the variable unset for the unsandboxed behaviour.

It simulates unikeys' half only. There is no real sandbox behind it, so every path is
reachable regardless and a redeemed bookmark grants nothing — it proves the UX and
proves nothing about whether macOS will co-operate. It is gated on the build being
unpackaged as well as on the variable, so it cannot be switched on in anything shipped.

Verified working: with it set, `load()` reports `sandboxed: true`, VSCode asks for
`~/Library/Application Support/Code/User` and WebStorm for the parent
`~/Library/Application Support/JetBrains`, Obsidian asks for nothing, and 12 of the 13
apps offer a grant button.

## Tasks

### Task 1: Spike — VSCode alone under sandbox

Status: blocked
Blocker: Needs Task 7's credentials. Verified 2026-08-12 that ad-hoc signing cannot
run a sandboxed Electron app at all: with `com.apple.security.app-sandbox` the sandbox
activates (container created, `NODE_OPTIONS` injection denied), but Chromium then dies
at `bootstrap_check_in com.ronkaa.unikeys.spike.MachPortRendezvousServer.<pid>:
Permission denied (1100)`. A sandboxed process may only register Mach names prefixed by
an *honored* `application-groups` entitlement, and ad-hoc signatures do not honor it.
Reproduced with both the standard darwin and the `mas` Electron 39.8.10 distributions,
so the `mas` distribution does not work around it. Task 1 therefore cannot start before
Task 7 — its "Blocked by: None" was wrong.

- **Type**: AFK
- **Blocked by**: Task 7 (was: None — corrected 2026-08-12, see blocker above)

#### What to build

The PRD's Phase 0 tracer bullet, kept as a technical spike (the UX decision it existed
to inform is already made — picker flow approved 2026-08-12). Add a temporary `mas-dev`
build target with the `com.apple.security.app-sandbox`,
`files.user-selected.read-write`, and `files.bookmarks.app-scope` entitlements. Replace
`resolveConfigPath` for VSCode only with a directory picker
(`securityScopedBookmarks: true`, `defaultPath` pointing at
`~/Library/Application Support/Code/User`). Persist the bookmark, quit, relaunch,
confirm access survives, and save a keybinding change end-to-end. Throwaway UI is fine —
task 2 replaces it.

#### Acceptance criteria

- [ ] `mas-dev` build launches with App Sandbox active (verify with `codesign -d --entitlements`)
- [ ] Directory picker opens directly at the hidden VSCode config folder via `defaultPath`
- [ ] Bookmark survives quit + relaunch; no re-prompt on second run
- [ ] A keybinding change saves end-to-end through `writeAtomic` under the grant

#### User stories addressed

- PRD Phase 0 (spike; decision point already resolved)

---

### Task 2: Production grant flow for one app (VSCode)

Status: done (code) / blocked (runtime verification)
Blocker: The last criterion needs a signed sandboxed build, so it waits on Task 7 —
not on Task 1, which turned out to be the same wait. Built directly rather than after
the spike, since the spike cannot run either and Task 6 was always going to replace its
scaffolding. `src/main/grants.ts` holds `isSandboxed()` (reads `process.mas`) and
`withGrant()`; `config-files.ts` is the only module that redeems a bookmark, and
`apps-service.ts` forwards an opaque string it never interprets. Covered by 16 new
tests in `src/main/grants.test.ts`; the suite is 583 green, up from 567.

- **Type**: AFK
- **Blocked by**: Task 1

#### What to build

The real version of the spike, as a full vertical slice. Store the base64
security-scoped bookmark per app in the existing store file. Inside `config-files.ts`,
wrap every filesystem operation (read, backup, `writeAtomic`) in
`startAccessingSecurityScopedResource` / `stop()` so the rest of the app never learns
about bookmarks. Add a distinct grant-needed `AppHealth` state (not `config-not-found`)
to `src/shared/ipc.ts`, and a "Grant access…" action on the Apps page in the renderer.

#### Acceptance criteria

- [x] Bookmark persisted in the store file per app; redeemed on every fs operation
- [x] Bookmark logic lives entirely inside `config-files.ts` — no other module imports it
- [x] `AppStatus` exposes a grant-needed state distinct from `config-not-found`
- [ ] Apps page shows "Grant access…" for ungranted apps and the picker flow completes from the UI
      — written and typechecked, but never run; no tick until someone clicks it
- [x] Existing non-mas (dmg) build behavior is unchanged — grants only engage in sandboxed builds.
      Observed, not inferred: the packaged `dist/mac-universal/unikeys.app` was launched and
      driven. `load()` returns `sandboxed: false`, `AppConfig` carries the new `grants: {}`,
      the Apps page renders all 13 cards with their previous health states, and the strings
      "Grant access" / "Change access" / "Needs access" appear nowhere on the page. No page
      errors and no console output.
- [ ] Read, backup, and write for VSCode all work end-to-end in the sandboxed build

#### User stories addressed

- PRD Phase 1.1 (grant model), 1.2 (persist and redeem bookmarks), 1.4 (IPC surface)

---

### Task 3: Roll grants out to all 13 apps

Status: done (code) / blocked (runtime verification)
Blocker: Same wait on Task 7. Every descriptor in `src/shared/apps.ts` gained a
`grantPath` — the directory the picker opens at and the only one unikeys will accept.
It is stored rather than derived from `configPaths` precisely because the JetBrains
three need the *parent* (`.../JetBrains`) for `expandGlob`'s `readdirSync`, and because
grants must be directories so `writeAtomic` can create its sibling temp file. Obsidian's
is `null`: there is no folder to ask for until the user names a vault.

**Correction (2026-08-12): an app holds a *set* of grants, not one.** `AppConfig.grants`
is a `Record<directory, bookmark>`. The symlinked-dotfiles case listed among the accepted
costs above needs two directories held at once — the read opens a path under the standard
location while `writeAtomic` resolves the link and writes in the repo — so a single
`grant` field could only ever hold one of them and reported the other as missing. Storing
one replaced the other, which made the two folders alternate: whichever had just been
granted worked, and the other came back as "moved, renamed or deleted", with re-granting
swapping the halves rather than settling. Keyed by directory so re-granting the same
folder refreshes its bookmark instead of accumulating dead ones. Regression test:
`grants.test.ts` › "settles after the user grants both folders, rather than alternating".

- **Type**: AFK
- **Blocked by**: Task 2

#### What to build

Extend the grant flow to every app in the catalogue. Each app gets a correct
`defaultPath` hint so the picker opens at the right hidden folder. JetBrains requires
granting the **parent** directory so `expandGlob` can enumerate `WebStorm*` variants —
the grant prompt must ask for the right level. Directory (not file) grants throughout,
so `writeAtomic` can create its sibling temp file.

#### Acceptance criteria

- [ ] All 13 config paths reachable via grants; each picker opens at its `defaultPath`
      — all 13 have a `grantPath` and it is passed to the panel, but no picker has been opened
- [x] JetBrains glob expansion works from a parent-directory grant — and the grant is *forced* to
      the parent: granting the visible `WebStorm2024.3` is refused, because accepting it would
      store a bookmark that makes every later read report itself stale with no way out
- [ ] Each app's read/backup/write cycle passes in the sandboxed build
- [x] "Here is where I looked" messaging (`candidatePaths`) still makes sense when a grant is
      missing — it is suppressed entirely: `grant-required` means unikeys never looked, so
      listing search paths would describe a search the sandbox did not permit

#### User stories addressed

- PRD Phase 1.1 (grant model across all apps)

---

### Task 4: Grant failure modes

Status: done (code) / blocked (runtime verification)
All four modes are implemented and unit-tested. Note what the unit tests do and do not
prove: they set `process.mas = true` against a real filesystem, where redeeming a
bookmark is a no-op — so they verify the decision logic exactly, and verify nothing at
all about how macOS behaves inside a real sandbox. That second half waits on Task 7,
and the same caveat applies to the ticks under tasks 2, 3 and 5. A stale grant is distinguished from a
missing one by redeeming the bookmark and testing the directory, so the message can say
"the folder moved" rather than repeating the first-run ask. A wrong folder is refused at
the moment of granting — before the bookmark is persisted and so before any write —
and accepted anyway if the config genuinely is inside it, which is what keeps overrides
and vaults working. The symlink case resolves through `realpathSync` and returns the
*resolved* directory, so the UI asks for the dotfiles repo rather than the folder that
already works. Note the runtime behaviour of these paths under a real sandbox is still
unverified for the same reason as tasks 2 and 3.

- **Type**: AFK
- **Blocked by**: Task 2

#### What to build

Handle the ways a grant goes wrong, each surfaced in the UI rather than logged. Stale
bookmark (folder moved or deleted) → re-prompt. Wrong folder granted → validate the
expected config file is present before saving and explain what was expected. Config
symlinked outside the grant (the dotfiles-repo case called out in the PRD) → detect via
`realpathSync`, explain, and prompt for the real location.

#### Acceptance criteria

- [x] Moving/deleting a granted folder produces a visible re-prompt path, not a silent failure
- [x] Granting a folder without the expected file is rejected with a clear explanation before any write
- [x] A config symlinked into a dotfiles repo is detected; the UI explains and requests the resolved location
- [x] No filesystem write ever occurs outside an active grant — `planWrite` returns an error on
      `grant-required` before it chooses a path, so the save cannot fall through to *creating*
      the file in an ungranted folder

#### User stories addressed

- PRD Phase 1.3 (failure modes), "The symlink case deserves emphasis"

---

### Task 5: App detection without /Applications scanning

Status: done (rescoped by user decision, 2026-08-12 — "keep path scan, handle ~/Applications")
`isInstalled` now takes the app's `AppConfig`. The `/Applications` scan is untouched
because it works sandboxed; in a sandboxed build a granted config directory or a
hand-picked path stands in as the signal for the `~/Applications` entries the sandbox
denies, which is the JetBrains Toolbox case. Also fixed a latent bug this uncovered:
`groupByApp` called `.filter(isInstalled)`, which passes the array index as the second
argument — harmless with the old one-parameter signature, wrong with the new one.

Original blocker, kept for the record:
Blocker: The task's premise is disproved and the replacement mechanism does not exist.
(1) `/Applications` **is** readable under App Sandbox — `/System/Library/Sandbox/Profiles/application.sb`
line 528 carries `(allow file-read* process-exec … (subpath "/Applications"))`. The PRD's
"not readable from a sandboxed process" is wrong, so the current scanner keeps working
for `/Applications`. (2) `~/Applications` **is** denied — the profile has no
`home-subpath "/Applications"` allow rule, and `~/Library` is denied outright at line 78.
That is the only real detection gap, and it is the JetBrains Toolbox case. (3) The
proposed fix is unimplementable as written: Electron 39 exposes only
`getApplicationNameForProtocol` / `getApplicationInfoForProtocol`, both keyed on URL
scheme, not bundle id. There is no LaunchServices bundle-id lookup in the JS API, so
`bundleId` detection needs a native module. Needs a user decision on scope.

- **Type**: AFK
- **Blocked by**: None - can start immediately (independent of the grant work)

#### What to build

Replace the `/Applications` scan in `src/main/apps-service.ts` with a bundle-identifier
lookup via LaunchServices, which works sandboxed with no filesystem enumeration. Add a
`bundleId` field to each entry in `src/shared/apps.ts`.

#### Acceptance criteria

- [~] Every catalogue entry has a `bundleId` — dropped by decision: the lookup it would feed
      does not exist in Electron's JS API, and `/Applications` scanning needs no replacement
- [~] `apps-service.ts` no longer reads `/Applications` or any `installPaths` — dropped by the
      same decision; the scan is explicitly permitted by the sandbox profile
- [x] Detection results match the current scanner for installed and not-installed apps
- [x] Works identically in dmg and sandboxed builds — outside the sandbox `isInstalled` is
      byte-for-byte what it was; inside, a granted config directory stands in for the
      unreadable `~/Applications`

#### User stories addressed

- PRD Phase 2 (app detection)

---

### Task 6: MAS build configuration

Status: done (config) / blocked (signed artefact)
Blocker: `npm run build:mas` cannot produce a `.pkg` until Task 7 — it now runs the whole
pipeline and stops exactly at `cannot find valid "Apple Distribution, 3rd Party Mac
Developer Application" identity`, which is that task and nothing else. Everything before
signing is verified by having actually run: electron-builder resolves the `mas` target,
downloads the **mas** Electron distribution (a different one from `darwin`), and packages
universal successfully.

Three things this turned up that the plan did not anticipate:

1. **A platform-specific `files` array replaces the root one, it does not extend it.**
   A `mas.files` of two exclusions produced an app.asar containing the entire
   repository — `.git`, `src/`, and the previous dmg build inside it. `mas.files` is gone;
   `electron-updater` is kept out by no longer being a dependency at all, which nothing
   imported and which takes its transitive packages with it.
2. **`--universal` has to be on the command line.** A target named on the CLI
   (`--mac mas`) ignores an `arch` in the config, so the first build silently produced
   arm64-only.
3. **The bundle was shipping 157 MB of unrelated repository furniture** — see the note
   under the acceptance criteria.

Two loose ends left deliberately, neither of which affects the build:

- `publish: {provider: generic, url: https://example.com/auto-updates}` in
  `electron-builder.yml` and `dev-app-update.yml` are now dead config — nothing reads
  them once `electron-updater` is gone. Left in place rather than removed as part of this
  work, but they describe an updater that no longer exists and are worth deleting.
- `pkg.installLocation: /Applications` has never actually executed, because the build
  stops before the `.pkg` is created. It matches electron-builder's default, so it should
  be inert, but it is unverified rather than confirmed.

- **Type**: AFK
- **Blocked by**: Task 1 (reuses the spike's mas-dev scaffolding)

#### What to build

The electron-builder half of PRD Phase 3. Create `build/entitlements.mas.plist` (sandbox,
user-selected read-write, app-scope bookmarks, application-groups) and the separate
`build/entitlements.mas.inherit.plist` for helper processes. Add the `mas` target to
`electron-builder.yml` with `hardenedRuntime: false` and a `provisioningProfile` path.
Strip `electron-updater` from the mas build (self-updating apps are banned on MAS). Do
**not** reuse `entitlements.mac.plist` — its `allow-unsigned-executable-memory` and
`allow-dyld-environment-variables` keys are rejected on upload. Keep `dmg`, `notarize`,
and `hardenedRuntime` settings out of the mas target and leave the existing dmg pipeline
untouched.

#### Acceptance criteria

- [ ] `npm run build:mas` produces a `.pkg` from the mas Electron distribution — reaches
      signing and stops there; the mas distribution and universal packaging are confirmed
- [x] mas entitlements contain none of the rejected keys from `entitlements.mac.plist`
- [ ] Helper processes signed with the `.inherit` entitlements file — configured, unverifiable
      until there is a certificate to sign with
- [x] No `electron-updater` code or dependency ships in the mas build — removed from
      `dependencies` outright rather than filtered, since nothing imported it, and
      `package-lock.json` re-synced so `npm ci` cannot reinstate it. Confirmed by listing
      the built asar: zero matches, in both the mas and the dmg bundle.
- [x] `npm run build:mac` (dmg path) still builds, signs, and notarizes exactly as before —
      built and signed with the Developer ID identity in a real run. Notarization itself was
      skipped deliberately (`-c.mac.notarize=false`): it needs API credentials, and its config
      is untouched.

**Found while verifying, and fixed:** the app.asar was 162 MB because the root `files`
list excluded almost nothing — `app-store-screenshots/`, a 521 MB Next.js project with
its own `node_modules`, was being packed into the shipped app, along with `docs/`,
`plans/`, `.claude/`, `.scratch/` and the test files. The app imports none of it. The
asar is now **1.47 MB** (from 162 MB) and the dmg **207 MB** (from 266 MB); the asar
holds `out/`, `resources/`, `node_modules/` and `package.json`, and nothing else. This
predates this plan and affects the **dmg release as much as the App Store one**, so the
exclusions went on the root `files` list rather than only on `mas`. It is the one change
here that touches the dmg pipeline; it removes files nothing loads, so the build, the
signature and the notarization step are unaffected — but it is a deliberate deviation
from "leave the dmg pipeline untouched" and can be reverted by deleting the added lines.

#### User stories addressed

- PRD Phase 3 (electron-builder config, traps 1–5)

---

### Task 7: Certificates & provisioning profile

Status: blocked
Blocker: Needs you — it is all Xcode and developer-portal UI, and nothing else in this
plan can be *run* until it is done. Today the keychain holds exactly one identity,
`Developer ID Application: Ron Kantor (9F9UG2CY8U)`, which signs the dmg and cannot sign
for the store. Team ID is **9F9UG2CY8U**; it is already baked into
`build/entitlements.mas.plist` as the app-group prefix.

Steps, with a check after each:

1. Xcode → Settings → Accounts → your Apple ID → Manage Certificates → **+** →
   **Apple Distribution**. Then **+** again → **Mac Installer Distribution**.
   Check: `security find-identity -v -p codesigning` lists both, and
   `security find-identity -v | grep Installer` shows the installer one.
2. developer.apple.com → Certificates, IDs & Profiles → Identifiers → **+** → App IDs →
   App → Bundle ID `com.ronkaa.unikeys` (explicit, not wildcard).
3. Same page → App Groups → **+** → `9F9UG2CY8U.com.ronkaa.unikeys`, then edit the App ID
   and enable the App Groups capability against it. This one is easy to skip and is not
   optional: without it Electron dies at launch on `bootstrap_check_in ... Permission
   denied (1100)` before any unikeys code runs.
4. Profiles → **+** → **Mac App Store Connect** distribution → the App ID above → download
   and save as `build/embedded.provisionprofile` (already gitignored).
   Check: `security cms -D -i build/embedded.provisionprofile | grep -A2 application-identifier`
   shows `9F9UG2CY8U.com.ronkaa.unikeys`.

- **Type**: HITL
- **Blocked by**: None - can start immediately (needs the user in Xcode / developer portal)

#### What to build

The certificates half of PRD Phase 3, done by the user with guidance. Create the
**Apple Distribution** and **Mac Installer Distribution** certificates in Xcode →
Settings → Accounts → Manage Certificates. Register App ID `com.ronkaa.unikeys` in the
developer portal and create a **Mac App Store** provisioning profile for it, saved as
`build/embedded.provisionprofile`.

#### Acceptance criteria

- [ ] Both distribution certificates present in the keychain
- [ ] App ID `com.ronkaa.unikeys` registered
- [ ] MAS provisioning profile at `build/embedded.provisionprofile` (and gitignored if it should not be committed)
- [ ] A signed build using these credentials passes local signature verification

#### User stories addressed

- PRD Phase 3 (certificates)

---

### Task 8: Submit to App Store

Status: blocked
Blocker: Task 7, and then a first run of the signed build. Do these in order before any
of the App Store Connect work — the first one is the single assumption everything else
rests on:

1. **Confirm the sandbox is actually detected.** `isSandboxed()` reads `process.mas`,
   and nothing has ever observed it: the ad-hoc spike died at the Mach-port check before
   any JavaScript ran. On first launch of the signed build the Apps page must read
   **"Needs access"**. If it says "Config not found" instead, `process.mas` is the wrong
   discriminator and needs replacing — checking whether `app.getPath('userData')` sits
   under `~/Library/Containers/` is the obvious substitute.
2. Grant VSCode's folder, quit, relaunch. The grant must survive; no second prompt.
3. Save a keybinding change and confirm the write and the backup both land. That closes
   the open criteria in tasks 1, 2 and 3 at once.
4. Try the JetBrains grant, which is the one with a non-obvious answer — the picker opens
   at `.../JetBrains` and picking the versioned folder inside it is correctly refused.

- **Type**: HITL
- **Blocked by**: Tasks 2, 3, 4, 5, 6, 7

#### What to build

PRD Phase 4. Create the app record in App Store Connect, build the signed `.pkg` with
`npm run build:mas`, upload with **Transporter.app** (not `notarytool`), complete
screenshots, description, privacy questionnaire, and pricing, then submit for review.
Budget for at least one rejection-and-appeal cycle (see PRD "Review risk"); the framing
is that the user explicitly grants each folder and unikeys edits only what it manages,
with backup behaviour visible in the UI.

#### Acceptance criteria

- [ ] App record exists in App Store Connect
- [ ] Signed `.pkg` uploads cleanly via Transporter (no entitlement or signing rejections)
- [ ] Screenshots, description, privacy questionnaire, and pricing completed
- [ ] Submitted for review; rejection responses (if any) tracked against PRD "Review risk" guidance

#### User stories addressed

- PRD Phase 4 (submit), Review risk
