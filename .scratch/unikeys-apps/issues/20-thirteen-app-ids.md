# 20 — Thirteen app ids

**What to build:** The spine. Every one of the seven new apps exists as an `AppId` with
a descriptor, a category and an adapter — three of those adapters being stubs that
refuse to parse or merge. After this ticket the app builds, the tests pass, and the
table shows thirteen columns, of which Zed, Warp and Obsidian are honestly broken and
say so. This has to be one commit because TypeScript's exhaustive records make it one:
`APP_IDS` → `APPS` → `FormatId` → `ADAPTERS` → `CategoryId` → `CATEGORY_LABELS`, each
link breaking the build until the next is filled in.

**Blocked by:** nothing. **Blocks:** 21, 22, 23, 24, 25, 26, 27.

**Status:** done — commit `af9e744`

## Ids and descriptors — `src/shared/apps.ts`

Keep `APP_IDS` and the `APPS` literal in the same order; `apps-service.ts` iterates
`Object.keys(APPS)` and a literal that disagrees silently reorders the status list
against the columns. Suggested order, grouping each fork beside its parent:

```
vscode, cursor, kiro, antigravity, zed,
webstorm, intellij, pycharm,
ghostty, cmux, iterm2, warp,
obsidian
```

| App | id | format | category | config path (under `~`) | install path |
| --- | --- | --- | --- | --- | --- |
| Kiro | `kiro` | `vscode-keybindings` | `ide` | `Library/Application Support/Kiro/User/keybindings.json` | `/Applications/Kiro.app` |
| Antigravity | `antigravity` | `vscode-keybindings` | `ide` | `Library/Application Support/Antigravity/User/keybindings.json` | `/Applications/Antigravity.app` |
| IntelliJ IDEA | `intellij` | `jetbrains-keymap` | `ide` | `Library/Application Support/JetBrains/IntelliJIdea*/keymaps`, then `…/IdeaIC*/keymaps` | `/Applications/IntelliJ IDEA.app`, `~/Applications/IntelliJ IDEA.app`, `~/Applications/JetBrains Toolbox/IntelliJ IDEA.app`, and the `IntelliJ IDEA Community Edition.app` variants |
| PyCharm | `pycharm` | `jetbrains-keymap` | `ide` | `Library/Application Support/JetBrains/PyCharm*/keymaps`, then `…/PyCharmCE*/keymaps` | `/Applications/PyCharm.app`, `~/Applications/PyCharm.app`, `~/Applications/JetBrains Toolbox/PyCharm.app`, and the `PyCharm CE.app` variants |
| Zed | `zed` | `zed-keymap` | `ide` | `.config/zed/keymap.json` | `/Applications/Zed.app`, `~/Applications/Zed.app` |
| Warp | `warp` | `warp-keybindings` | `terminal` | `.warp/keybindings.yaml` | `/Applications/Warp.app`, `~/Applications/Warp.app` |
| Obsidian | `obsidian` | `obsidian-hotkeys` | `notes` | **none — see below** | `/Applications/Obsidian.app`, `~/Applications/Obsidian.app` |

The Kiro and Antigravity paths are confirmed on this Mac: both apps are installed,
both have a `User/` directory under `Library/Application Support/<Name>/`, and
Antigravity's `keybindings.json` is present and holds standard VSCode-shaped entries.
Kiro has no `keybindings.json` yet, which is the `config-not-created` state
`diagnose()` already handles — do not treat it as a bug.

Reload hints: the two VSCode forks pick `keybindings.json` up live, same wording as
VSCode's. The two JetBrains IDEs need a restart, same wording as WebStorm's. Zed
reloads `keymap.json` on save. Warp applies `keybindings.yaml` on relaunch. Obsidian
needs a reload of the app or the vault.

Obsidian's config lives inside a vault (`<vault>/.obsidian/hotkeys.json`) and there is
no standard location, so its `configPaths` is `[]`. Ticket 25 owns making that read
sensibly; here it only has to not crash.

## The `notes` category

Obsidian is neither an editor nor a terminal. Add `notes` to `CATEGORY_IDS` and
`CATEGORY_LABELS` (label: `Notes`), keeping the ordering comment's promise that the
category order runs with `APP_IDS` rather than against it.

## Stub adapters

`src/shared/adapters/zed.ts`, `warp.ts`, `obsidian.ts`, each exporting an `Adapter`
registered in `ADAPTERS` under its new `FormatId`:

- `parse` → `{ ok: false, error: 'The Zed adapter is not implemented yet.' }`
- `merge` → the same shape
- `encodeChord` → `{ ok: false, reason: … }`; `decodeChord` → `null`
- `defaults` → `{ availability: 'unavailable', note: …, bindings: [] }`
- `emptyContents` → `''`

A stub must never silently succeed. `parse` failing puts the column in
`config-unparseable` with a message the user can read, which is the honest state for a
format unikeys cannot yet handle.

## Catalogue mappings for the reuse group

In `catalogue.json`, for every action that has a `vscode` command add the identical
`kiro` and `antigravity` commands, and for every action that has a `webstorm` command
add the identical `intellij` and `pycharm` commands. All four are mechanical copies —
Kiro and Antigravity are Code OSS forks and share VSCode's command ids, and the
JetBrains action ids in the catalogue (`SaveAll`, `GotoFile`, `$Undo`) are
platform-level, not WebStorm-specific.

Add no `zed`, `warp` or `obsidian` mappings. Tickets 23–25 emit those as fragments and
26 folds them in.

## Two unions that must widen here, not later

Both are exhaustive records, so widening them anywhere but the spine breaks a file
another ticket owns.

**`AppHealth`** in `src/shared/ipc.ts` gains `config-path-required` — the state for an
app that has no standard config location and needs the user to point at one. Obsidian
is the only app in that state today. Add the variant, add its entry to `HEALTH_LABELS`
in `AppsPage.tsx` (which is a `Record` keyed by `AppHealth` and will not compile
without it), and give it a placeholder message. Ticket 25 fills in the behaviour and
the real wording; it must not have to touch the renderer to do so.

**The six-app assumptions in the test suite.** `view.test.ts` builds its state from
`createEmptyStore()` and `buildTableView` derives its columns from
`APP_IDS.filter(enabled)`, so several assertions are exact lists of the current six —
`ALL_APPS` at line 43, `expect(ghostty.apps).toEqual([...ALL_APPS])` at 203, and
`expect(view.apps).toEqual(['vscode', 'webstorm', …])` at 247. `reducer.test.ts` has
similar literals. These go red the moment `APP_IDS` grows, so updating them is part of
this ticket, not a surprise for whoever merges next. Prefer deriving from `APP_IDS`
over hand-listing thirteen ids, so the next app added does not repeat this.

## Definition of done

- [x] `APP_IDS` holds thirteen ids and `APPS` lists them in the same order
- [x] `FormatId`, `ADAPTERS`, `CategoryId` and `CATEGORY_LABELS` are all exhaustive again
- [x] The three stub adapters fail loudly, with a message naming the app
- [x] Every action mapping `vscode` also maps `kiro` and `antigravity`; every action mapping `webstorm` also maps `intellij` and `pycharm`
- [x] `catalogue.test.ts` passes against the widened catalogue
- [x] `AppHealth` has a `config-path-required` variant with a `HEALTH_LABELS` entry and a placeholder message
- [x] `view.test.ts` and `reducer.test.ts` pass with thirteen apps, deriving from `APP_IDS` rather than hand-listing them
- [x] A store written before this change still loads, and gains the seven new apps from `createEmptyStore()`'s base without a migration
- [x] `npm test`, `npm run typecheck` and `npm run lint` pass
