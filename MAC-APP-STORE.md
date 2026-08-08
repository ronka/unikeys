# Getting unikeys onto the Mac App Store

What it would take to make unikeys submittable, why it is not submittable today, and the
order to do the work in.

**Estimate: 1–2 weeks.** Roughly half a day of build configuration and certificates; the
rest is rebuilding how the app reaches files. Review outcome is not guaranteed even then
(see [Review risk](#review-risk)).

The alternative — a signed, notarized DMG you host yourself — already works and ships
today. See [RELEASE.md](./RELEASE.md). Read [Is this worth it?](#is-this-worth-it) before
starting.

---

## The one rule that drives everything

Every Mac App Store app must run inside **App Sandbox**. Apple enforces it at
submission; there is no exemption to apply for.

A sandboxed app may read and write:

- its own container, `~/Library/Containers/com.ronkaa.unikeys/`
- paths the user explicitly chose in a macOS file dialog, for as long as that grant lasts

Nothing else. Every hardcoded path in unikeys is denied.

## What breaks

| Where | What it does | Why the sandbox denies it |
| --- | --- | --- |
| `src/main/config-files.ts` — `resolveConfigPath` | Joins `homedir()` with 13 hardcoded relative paths | No access to arbitrary home-dir paths |
| `src/main/config-files.ts` — `candidatePaths` | Same, for "here is where I looked" messages | Same |
| `src/main/config-files.ts` — `expandGlob` | `readdirSync` on `.../JetBrains/` to expand `WebStorm*` | Enumerating a directory needs that **parent** granted |
| `src/main/config-files.ts` — `writeAtomic` | Writes `.name.unikeys-PID.tmp` **beside** the target, then renames | Creating a sibling needs **directory** access, not file access |
| `src/main/config-files.ts` — `writeAtomic` | `realpathSync` follows symlinks before writing | A config symlinked into `~/dotfiles` resolves outside every grant |
| `src/main/apps-service.ts` | Scans `installPaths` under `/Applications` | Not readable from a sandboxed process |

The symlink case deserves emphasis. The code comment at `writeAtomic` says a config
symlinked into a dotfiles repo "is exactly the setup a unikeys user is likely to have."
Those users cannot be served by a sandboxed build unless they also grant the dotfiles
repo — which the UI would have to detect and explain.

## What already works

The layering pays off here. These need **no** changes:

1. **Adapters** (`src/shared/adapters/`) — pure `string → string`, no filesystem
2. **Table reducer, chord model, catalogue** — pure
3. **Backups** — written to `ensureLocation().backupDirectory`, derived from
   `app.getPath('userData')`, which the sandbox relocates into the container automatically
4. **Store and history files** — same, `userData`-derived
5. **Renderer** — never touches `fs`, already behind typed IPC

So the blast radius is essentially two files: `config-files.ts` and `apps-service.ts`.

---

## Phase 0 — Spike one app (2 hours)

Do not start the full port before this. Make **VSCode alone** work under sandbox and look
at the result.

1. Add a temporary `mas-dev` build with `com.apple.security.app-sandbox`,
   `files.user-selected.read-write`, and `files.bookmarks.app-scope`
2. Replace VSCode's `resolveConfigPath` with a directory picker
3. Persist the bookmark, quit, relaunch, confirm access survives
4. Save a keybinding change end-to-end

**Decision point.** Try the first-run flow as a user would. If picking one hidden
directory feels bad, picking thirteen will not feel better.

## Phase 1 — Rewrite file access (the bulk of the work)

### 1.1 Grant model

Users grant **directories**, not files — `writeAtomic` needs to create a sibling temp
file. For JetBrains, the grant must be the parent so `WebStorm*` can be globbed.

```ts
const { filePaths, bookmarks } = await dialog.showOpenDialog({
  properties: ['openDirectory'],
  message: 'Choose the folder containing VSCode’s keybindings.json',
  defaultPath: join(homedir(), 'Library/Application Support/Code/User'),
  securityScopedBookmarks: true   // mas builds only
})
```

`defaultPath` still works — the picker itself is outside the sandbox, so it can open
straight at the right hidden folder. That is what makes this bearable.

### 1.2 Persist and redeem bookmarks

Store the base64 bookmark per app in the existing store file. Wrap every filesystem
operation:

```ts
const stop = app.startAccessingSecurityScopedResource(bookmark)
try {
  // existing read / backup / writeAtomic logic, unchanged
} finally {
  stop()
}
```

Do this **inside** `config-files.ts` so the rest of the app never learns about bookmarks.

### 1.3 Handle the failure modes

1. Bookmark stale (user moved or deleted the folder) — re-prompt
2. User granted the wrong folder — validate the expected file is present before saving
3. Symlink escapes the grant — detect via `realpathSync`, explain, prompt for the real
   location
4. No grant yet — a distinct `AppHealth` state, not `config-not-found`

### 1.4 Extend the IPC surface

`AppStatus` needs a grant state, and the renderer needs a "Grant access…" action.
`src/shared/ipc.ts` and the Apps page both change.

## Phase 2 — App detection (half a day)

Replace `/Applications` scanning. Ask LaunchServices instead:

```ts
// Works sandboxed; no filesystem enumeration
const installed = app.getApplicationNameForProtocol // or shell/LaunchServices lookup
```

Practical approach: look apps up by bundle identifier rather than by path. Requires adding
a `bundleId` to each entry in `src/shared/apps.ts`.

## Phase 3 — Build and certificates (half a day)

### Certificates (Xcode → Settings → Accounts → Manage Certificates)

1. **Apple Distribution** — signs the app
2. **Mac Installer Distribution** — signs the `.pkg`
3. Register App ID `com.ronkaa.unikeys` in the developer portal
4. Create a **Mac App Store** provisioning profile for it

### electron-builder

```yaml
mas:
  category: public.app-category.developer-tools
  entitlements: build/entitlements.mas.plist
  entitlementsInherit: build/entitlements.mas.inherit.plist
  provisioningProfile: build/embedded.provisionprofile
  hardenedRuntime: false   # not used for MAS
```

`build/entitlements.mas.plist` needs at minimum:

```xml
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.files.user-selected.read-write</key><true/>
<key>com.apple.security.files.bookmarks.app-scope</key><true/>
<key>com.apple.security.application-groups</key><array><string>TEAMID.com.ronkaa.unikeys</string></array>
```

Traps, each of which fails the build or the upload:

1. The existing `entitlements.mac.plist` must **not** be reused —
   `allow-unsigned-executable-memory` and `allow-dyld-environment-variables` are rejected
2. Remove `electron-updater`; self-updating apps are banned on MAS
3. The `mas` target downloads a **different** Electron distribution
4. Helper processes need the separate `.inherit` entitlements file
5. `dmg`, `notarize`, and `hardenedRuntime` settings do not apply and should not leak in

## Phase 4 — Submit

1. Create the app record in App Store Connect
2. `npm run build:mas` → produces a `.pkg`
3. Upload with **Transporter.app** (not `notarytool` — that is for Developer ID)
4. Screenshots, description, privacy questionnaire, pricing
5. Submit for review

---

## Review risk

An app whose purpose is modifying other applications' data draws scrutiny. This is not an
automatic rejection — the "user explicitly grants each folder, unikeys edits only what it
manages" framing is defensible, and editors that modify user-chosen files ship on MAS
routinely. But budget for at least one rejection-and-appeal cycle.

Two things that help: never touch a path the user did not grant, and make the backup
behaviour visible in the UI.

## What it costs the user

1. First run becomes 13 directory grants instead of zero
2. Dotfiles-symlink users need an extra grant and an explanation
3. No auto-update — every release goes through review
4. Apple takes its cut if you ever charge

## Is this worth it?

**Ship the DMG unless you specifically need App Store discovery or payments.** Developer
tool users install notarized DMGs without hesitation, Homebrew Cask reaches the same
audience, auto-update works, and the app behaves as designed with zero setup friction.

The App Store buys discovery and payment handling. It costs 1–2 weeks, a materially worse
first run, no auto-update, and review risk.

If you want it anyway: **start with Phase 0.** Two hours tells you more than this document
can.
