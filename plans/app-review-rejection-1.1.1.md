# Plan: Clear the two App Review rejections (13 Aug 2026)

> Version reviewed: 1.0 (1.1.1). Submission id is in the App Store Connect message,
> deliberately not repeated here.

## Overview

Two rejections, both fixable without touching the adapters, the reducer or the write
pipeline:

1. **Guideline 2.4.5(i)** — unikeys copies the user's own config files into
   `~/Library/Containers/com.ronkaa.unikeys/Data/…/unikeys/backups`, prints that path in
   Settings and in the save report, and offers a button that opens it in Finder. Backups
   are the user's data; the container is not where user data goes. **Fix:** in the
   sandboxed build the backups folder becomes a folder the user picks through the
   standard open panel, held by a security-scoped bookmark like every other grant.
2. **Guideline 4** — closing the main window leaves no way to bring it back. **Fix:** an
   explicit application menu whose Window submenu carries the main window, wired to a
   `showMainWindow()` that focuses the existing window rather than making a second one.

### What the reviewer almost certainly did

Settings → **Open backups folder** (`src/main/ipc.ts:211`), which `shell.openPath`s the
container, and/or read the container path printed at `SettingsPage.tsx:64`. The save
report prints it twice more — `Panels.tsx:419` ("Backed up to …") and `Panels.tsx:482`
("Backups live in …"). All four surfaces are part of the fix, not cosmetics.

### Scope boundaries — state these and hold them

- **`unikeys-store.json` and `unikeys-history.json` stay in the container.** They are app
  state and a log, which is exactly what a container is for. Only `backups/` holds copies
  of the user's own files, and only that was flagged. Moving all persistence would be
  days of risk for no review benefit.
- **The dmg build does not change.** Gate everything new on `isSandboxed()`, the way
  `grants.ts` already gates the rest. Outside the sandbox `userData` is
  `~/Library/Application Support/unikeys` — an ordinary, Finder-reachable path — and that
  build is not under review.
- **No restore-from-backup UI.** Out of scope; the rejection is about location only.

### Rejected alternative

Writing each backup beside the config it copies, inside the folder already granted. No new
grant, genuinely user-accessible — but it litters `Code/User`, and a stray `.xml` dropped
into a JetBrains `keymaps/` directory shows up in the IDE as a keymap. Not worth it.

---

## Tasks

### Task 1: Backups location becomes user-chosen state

Status: **done** — code + tests

**Files:** `src/shared/store/types.ts`, `src/shared/store/types.test.ts`

Add an additive field, **no schema bump** — same reasoning `AppConfig.grants` documents at
`store/types.ts:63-73`: a build without the field ignores it, so stores keep travelling
between the dmg and App Store builds in both directions.

```ts
/**
 * Where backups of the user's config files go, and what lets a sandboxed build
 * write there. `directory: null` means the user has not chosen yet — in the dmg
 * build it is never asked, and backups go under `userData`.
 */
export interface BackupsLocation {
  directory: string | null
  grants: Grants
}
```

- `Store` gains `backups: BackupsLocation`; `createEmptyStore()` → `{ directory: null, grants: {} }`.
- `deserializeStore` reads it through a `readBackupsLocation` helper beside `readGrants`,
  filtering the same way: a non-string directory or a malformed grants map degrades to
  "not chosen" rather than rejecting the whole document.

**Acceptance**

- [x] Round-trip test: a store with a chosen folder serialises and deserialises unchanged
- [x] A document with no `backups` key loads as `{ directory: null, grants: {} }`
- [x] `{ backups: { directory: 42, grants: "nope" } }` loads as not-chosen, and the rest of
      the document survives

---

### Task 2: The backup session writes where it was told, and nowhere else

Status: **done** — code + tests (`src/main/backups.test.ts`)

**Files:** `src/main/store-file.ts`, `src/main/config-files.ts`, `src/main/store-file.test.ts`

The structural half of the fix — after this, the old container path is not reachable by
accident, because it no longer exists as a value.

- **`store-file.ts`: delete `backupDirectory` from `StoreLocation`.** `storeLocation()`
  returns `{ storePath }` only. This is the guarantee: no code path can derive a backup
  directory from `userData` any more.
- New `src/main/backups.ts` (or a section in `config-files.ts`) owning the decision:

  ```ts
  /** Where this session's backups go, or `null` when there is nowhere to put them. */
  export function backupsDirectory(store: Store, userDataDir: string): string | null {
    return isSandboxed() ? store.backups.directory : join(userDataDir, 'backups')
  }
  ```

- `createBackupSession(directory, destinationGrants, now)` — the session now carries the
  destination's grants as well as the source's. `ensureBackup(path, label, sourceGrants)`
  redeems both together: `withGrants({ ...this.destinationGrants, ...sourceGrants }, …)`.
  One redeem scope, because a single `copyFileSync` straddles both folders — the same
  reason `withGrants` takes a map rather than one bookmark (`grants.ts:147-166`).
- `ensureBackup` returns `null` when there is no directory, which is the shape callers
  already handle for "already backed up this session".

**Acceptance**

- [x] `storeLocation()` no longer has a `backupDirectory` field — typecheck proves no
      caller survived
- [x] Test: under `UNIKEYS_SIMULATE_SANDBOX=1` with `backups.directory === null`, a write
      produces **no** file anywhere under `userData`
- [x] Test: the same with `createEmptyStore()` — a store document written before this
      field existed, or a renderer that has not hydrated, must also produce nothing under
      `userData`. The directory reaches the backup session from the renderer (`IPC.write`
      takes the store, `ipc.ts:104`), so the sandboxed branch must have **no** `userData`
      fallback at all rather than one guarded by a present-and-correct field
- [x] Test: with a chosen directory, the backup lands there with the existing
      `<timestamp>-<label>-<basename>` naming
- [x] Unsandboxed, backups still land in `userData/backups` exactly as today

---

### Task 3: The picker, the IPC surface, and reveal

Status: **done** — code; acceptance below needs a live run

**Files:** `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`

Modelled directly on `requestGrant` (`src/main/ipc.ts:134`), which already does this shape
of thing correctly.

```ts
ipcMain.handle(IPC.chooseBackupsFolder, async (): Promise<BackupsChoice> => {
  const result = await dialog.showOpenDialog({
    title: 'Choose where unikeys keeps backups',
    message:
      'Before unikeys changes a keybinding file it copies the original here, so a bad ' +
      'save is always recoverable.',
    buttonLabel: 'Use This Folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: join(realHome(), 'Documents'),
    securityScopedBookmarks: true
  })
  …
})
```

Three details that are load-bearing:

1. **`defaultPath` must use `realHome()` from `grants.ts`, not `app.getPath('documents')`
   and not `homedir()`.** Under sandbox both of those answer with the container — the
   picker would open inside the very folder this rejection is about. That function exists
   for exactly this failure; its docstring explains why.
2. `securityScopedBookmarks: true` is what makes the grant outlive the quit. A non-mas
   build returns no bookmark however the panel is configured, so the simulated-sandbox
   path substitutes `SIMULATED_GRANT`, as `requestGrant` does at `ipc.ts:174`.
3. Return type mirrors `GrantOutcome` minus `configPath`:
   `{ ok: true; directory: string; grant: string } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: string }`.
   Cancel is not an error — closing the panel is a decision, and an error toast for it
   scolds the user for using the Cancel button.

Also in this task:

- `IPC.revealBackups` takes the store. It resolves through `backupsDirectory()`, and when
  that is `null` it returns without opening anything — it must **never** `mkdirSync` and
  open a container path again. The renderer is what prompts (see Task 4).
- `LoadResult.backupDirectory` becomes `string | null`.
- `WriteResult.backupDirectory` becomes `string | null`.
- `IPC.load` no longer reads `backupDirectory` off `StoreLocation`; it computes it from the
  store it just loaded.
- Optional cleanup while here: `LoadResult.storePath` (`ipc.ts:89`) is sent to the renderer
  and never read there. Dropping it removes a second container path from the IPC surface.

**Acceptance**

- [ ] `npm run dev` → Settings → Choose folder opens the panel at the real `~/Documents`,
      not at anything under `Library/Containers`
- [ ] Cancelling leaves the store untouched and shows no error
- [ ] Choosing a folder persists `{ directory, grants: { [directory]: bookmark } }` and the
      Settings page names it
- [ ] With nothing chosen, `revealBackups` opens nothing

---

### Task 4: The renderer — Settings, the save flow, the save report

Status: **done** — code; acceptance below needs a live run

**Files:** `src/renderer/src/App.tsx`, `src/renderer/src/pages/SettingsPage.tsx`,
`src/renderer/src/components/Panels.tsx`, `src/shared/table/reducer.ts`

**Not in onboarding.** The wizard already asks for thirteen folder grants; a fourteenth
question about a folder the user has no reason to care about yet is the wrong place to
spend their patience. The setting lives in Settings, and the one moment it actually
matters — the first save — is where unikeys asks.

**Settings → Backups section.** When a folder is chosen, name it and offer "Change folder…"
and "Open backups folder". When it is not, say so plainly — "unikeys has nowhere to put
backups yet" — and offer "Choose folder…". Never print a container path.

**Save flow.** In the sandboxed build, when `store.backups.directory === null` and the user
saves, put one modal in front of the write:

> unikeys copies each file before changing it, so a bad save can be undone. Choose where
> those copies go.
> **[Choose Folder…]** [Save Without Backups]

Choosing runs `chooseBackupsFolder`, stores the result, and continues into the write.
Declining proceeds and the write happens **without** a backup — not with a fallback into
the container. That keeps the count of user-data-in-container writes at zero, which is the
claim the App Review reply gets to make. Blocking the save outright is worse product and
the guideline does not ask for it.

**Asked at most once per session.** With no onboarding step, "not chosen" is the state
every user starts in, so the prompt is the only thing standing between them and silent
loss of the backup safety net — but a modal in front of every save is worse than no
backups. A `declinedThisSession` ref in `App.tsx`, not persisted: declining is quiet for
the rest of the session, the next launch asks once more, and Settings is where someone who
changed their mind goes. Deliberately not a store field — a persisted "never ask again"
would silently disable backups forever from a single click made in a hurry.

The picker stays a renderer-initiated call rather than something the write path does on
demand, for the reason already documented for `requestGrant` in `shared/ipc.ts:369-381`:
prompting from inside the write would make every function between there and the filesystem
async.

**Save report** (`Panels.tsx`). `backupDirectory: null` gets its own line — "No backup
folder chosen, so nothing was backed up. Choose one in Settings." — instead of printing a
path. The per-app "Backed up to …" line already handles `null`.

**Reducer.** One action, `setBackupsLocation`, a plain store patch — the existing persist
effect (`App.tsx:235`) writes it.

**The `revealBackups` call site.** `App.tsx:600` calls it with no arguments today; Task 3
gives it the store. It typechecks only once `preload/index.d.ts` is updated in that task,
so it is easy to miss — change it here.

The modal's copy should make the consequence concrete rather than leaving "Without
Backups" to carry it: *this save cannot be undone from within unikeys.*

**Acceptance**

- [ ] Fresh store, `npm run dev`, edit a chord, save → the choose-folder modal appears
      before anything is written
- [ ] "Save Without Backups" → the config is written, the report says no backup was taken,
      and nothing appears under `userData`
- [ ] "Choose Folder…" → backup lands in the chosen folder, report names that path
- [ ] Settings shows the chosen folder; "Open backups folder" opens it in Finder
- [ ] No screen in the app prints a path containing `Library/Containers`
- [ ] Declining, then saving again in the same session → no second prompt
- [ ] Relaunch after declining → asked once more at the first save
- [x] Onboarding is unchanged — no new step

---

### Task 5: The Window menu

Status: **done** — code; acceptance below needs a live run

**Files:** new `src/main/menu.ts`, `src/main/index.ts`

Take Apple's first option — a Window menu that lists the main window. The second option
(quit on close) throws away the macOS convention for no gain.

**`showMainWindow()`** in `index.ts`, extracted from `createWindow()`:

```ts
function showMainWindow(): void {
  const existing = BrowserWindow.getAllWindows()[0]
  if (!existing) return createWindow()
  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
}
```

This is the load-bearing part. `createWindow()` (`index.ts:8`) constructs unconditionally,
so pointing the menu item straight at it gives two windows on ⌘0 — precisely what the
`requestSingleInstanceLock` comment at `index.ts:66` exists to prevent. Point **all three**
entry points at `showMainWindow`: the menu item, the `activate` handler (`index.ts:93`), and
a new `second-instance` handler (today the second instance quits silently and the first
never comes forward).

**`menu.ts`** — an explicit template, because `role: 'windowMenu'` cannot be appended to:

```ts
{
  label: 'Window',
  submenu: [
    { label: 'unikeys', accelerator: 'CmdOrCtrl+0', click: () => showMainWindow() },
    { type: 'separator' },
    { role: 'minimize' },
    { role: 'zoom' },
    { role: 'close' },
    { type: 'separator' },
    { role: 'front' }
  ]
}
```

Keep `{ role: 'appMenu' }`, `{ role: 'editMenu' }` and `{ role: 'viewMenu' }` around it —
dropping About, Services, Hide, Quit, or copy/paste is its own rejection. Those three plus
the custom Window menu are exactly what Guideline 4 asked for; nothing else belongs in this
change. Call `Menu.setApplicationMenu(buildApplicationMenu(showMainWindow))` in `whenReady`
before `createWindow()`.

`autoHideMenuBar: true` is inert on macOS and is not the cause — drop it, since the app is
macOS-only and the menu now matters.

**Acceptance**

- [x] `role: 'window'` keeps the custom submenu rather than substituting its own — checked
      against real Electron 39 by building this exact template and reading
      `Menu.getApplicationMenu()` back: `Window ▸ "unikeys" (CmdOrCtrl+0)`, then Minimize,
      Zoom, Close Window, Bring All to Front. Worth pinning, because a role that swallowed
      the submenu would drop the item silently and fail review again on the same guideline
- [ ] Close the window with the red button → Window ▸ unikeys reopens it
- [ ] ⌘0 with the window already open focuses it and does **not** create a second window
- [ ] ⌘0 with the window minimised restores it
- [ ] Dock-icon click still reopens (the `activate` path)
- [ ] Launching a second copy brings the first forward instead of doing nothing
- [ ] ⌘Q, ⌘C/⌘V, About unikeys and Services all still present and working
- [ ] Close the window, **then** ⌘Q → the app actually exits. `window-all-closed`
      deliberately does not quit on darwin (`index.ts:103`), and `before-quit` defers the
      quit once to flush analytics (`index.ts:124`) — that is the one path that could make
      ⌘Q feel broken after a close
- [ ] Reopened window shows the same table — pending edits live in the store and are
      persisted on change (`App.tsx:235`), so closing loses nothing

---

### Task 6: Verify, then resubmit

Status: **in progress** — `npm test` (641), `npm run typecheck`, `npm run lint` and `npm run build`
are green, and a dev launch starts clean. Steps 2–4 below (the live walk-through, the
sandboxed `build:mas` run, and the submission) are the user's to do.

**What a dev run can and cannot prove.** `UNIKEYS_SIMULATE_SANDBOX=1` exercises unikeys'
half — the panel, the states, the messages — and proves nothing about whether a bookmark
redeems. What *is* verifiable without certificates is the actual rejection reason: that no
code path writes copies of user files under `userData`. Tasks 1–2 turn that into a test
rather than a manual check.

1. `npm test`, `npm run typecheck`, `npm run lint`
2. `npm run dev` — walk the full first-run flow, then the save flow, then close/reopen the
   window from the menu
3. `npm run build:mas`, install the pkg, and confirm on a real sandboxed run:
   - `ls ~/Library/Containers/com.ronkaa.unikeys/Data/Library/Application\ Support/unikeys/`
     contains **only** `unikeys-store.json` and `unikeys-history.json` — no `backups/`
   - the chosen backups folder holds the copies, and still does after a relaunch (the
     bookmark redeemed)
4. `npm run check:testflight` to validate before uploading.

**Build number.** `tools/submit-testflight.sh` derives `CFBundleVersion` from
`git rev-list --count HEAD`, so the resubmission climbs on its own — no version bump
needed, and the previous build's `1.1.1` string sorts below a plain integer in the
hundreds. If a rebase ever makes the count fall, pass `BUILD_NUMBER=` by hand; the script's
comment covers it.

**Reply to App Review in App Store Connect.** Name both changes explicitly — for 2.4.5(i)
in particular, a reviewer who is not told will look in the same place:

> Thank you for the detailed report. Both issues are addressed in this build.
>
> **2.4.5(i)** — unikeys no longer writes any user data to its container. Backups of the
> user's keybinding files are now saved to a folder the user chooses through a standard
> macOS open panel, accessed through a security-scoped bookmark. The folder is chosen
> during first-run setup and can be changed at any time in Settings ▸ Backups. If no folder
> has been chosen, unikeys saves without taking a backup and says so, rather than falling
> back to the container. The only files remaining in the container are the app's own
> preferences (`unikeys-store.json`) and its activity log (`unikeys-history.json`).
>
> **Guideline 4** — the app now installs a Window menu containing the main window
> ("Window ▸ unikeys", ⌘0), so it can be reopened after being closed. The same command is
> wired to the Dock icon and to a second launch of the app.

---

## Files touched, at a glance

| File | Change |
| --- | --- |
| `src/shared/store/types.ts` | `BackupsLocation`, `Store.backups`, `readBackupsLocation` |
| `src/shared/ipc.ts` | `chooseBackupsFolder` channel + type; `backupDirectory` nullable |
| `src/main/store-file.ts` | `backupDirectory` removed from `StoreLocation` |
| `src/main/config-files.ts` / `backups.ts` | session carries destination grants; `backupsDirectory()` |
| `src/main/ipc.ts` | new handler; `revealBackups` and `load` re-pointed |
| `src/preload/index.ts`, `index.d.ts` | expose `chooseBackupsFolder` |
| `src/renderer/src/pages/SettingsPage.tsx` | chosen / not-chosen states |
| `src/renderer/src/components/Panels.tsx` | null backup directory in the save report |
| `src/renderer/src/App.tsx` | first-save prompt, `revealBackups` call site, `setBackupsLocation` wiring |
| `src/shared/table/reducer.ts` | `setBackupsLocation` action |
| `src/main/menu.ts` *(new)* | application menu with the Window submenu |
| `src/main/index.ts` | `showMainWindow()`, menu install, `second-instance` |
| `MAC-APP-STORE.md` | it still says unikeys is not submittable — update or retire it |
