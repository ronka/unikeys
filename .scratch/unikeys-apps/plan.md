# Plan: seven more apps

Status: ready-for-agent

Adds IntelliJ IDEA, PyCharm, Kiro, Antigravity, Zed, Warp and Obsidian to unikeys —
taking the table from six columns to thirteen.

"Wrap" is read as **Warp**, the terminal. That is the plain reading and nothing else
fits; the assumption is stated here rather than blocking on it.

---

## What the architecture already gives us

Support for an app is data, not code. `src/shared/apps.ts` holds the id, the format,
the config paths and the install paths; `src/shared/catalogue/catalogue.json` holds the
per-app command mappings; `src/shared/adapters/` holds one pure `string → string`
module per *format*. Nothing above the adapter layer names an app — `apps-service.ts`
iterates `Object.keys(APPS)`, the reducer and the table view take `AppId` generically,
and `createEmptyStore()`/`deserializeStore()` seed from `APP_IDS`, so an added app gets
a store entry with no migration.

That is why four of the seven apps need **no new adapter at all**:

| App | Format | Adapter |
| --- | --- | --- |
| IntelliJ IDEA | `jetbrains-keymap` | existing, generalised off WebStorm |
| PyCharm | `jetbrains-keymap` | existing, generalised off WebStorm |
| Kiro | `vscode-keybindings` | existing, unchanged apart from its `apps` list |
| Antigravity | `vscode-keybindings` | existing, unchanged apart from its `apps` list |
| Zed | `zed-keymap` | **new** |
| Warp | `warp-keybindings` | **new** |
| Obsidian | `obsidian-hotkeys` | **new** |

## What forces one serial commit first

TypeScript makes the id-level change atomic. Four exhaustive records chain off each
other, and every link breaks the build until the next one is filled in:

```
APP_IDS  →  APPS: Record<AppId, AppDescriptor>
            AppDescriptor.format  →  FormatId  →  ADAPTERS: Record<FormatId, Adapter>
            AppDescriptor.category  →  CategoryId  →  CATEGORY_LABELS: Record<CategoryId, string>
```

On top of that, `validateCommands` in `catalogue/types.ts` rejects any `commands` key
that is not already an `AppId`, so no catalogue mapping can land before the id does.

So ticket **20** ships all thirteen ids, descriptors, the new `notes` category, and
**stub adapters** for the three new formats — `parse`/`merge` returning
`{ ok: false, error: … }`, `defaults()` returning `unavailable`, `emptyContents()`
returning `''`. Every downstream worktree then replaces exactly one adapter file and
adds its own fixtures directory. Without the stubs the fan-out is not parallel: it
serialises on a main branch that does not compile.

## The catalogue conflict, and the decision

`catalogue.json` is 38 actions and every one of them wants a new key per app. Three
agents editing it simultaneously conflict on nearly every line. The split is:

- **Reuse-group mappings land in the spine (ticket 20).** `kiro` and `antigravity`
  copy `vscode`'s command verbatim; `intellij` and `pycharm` copy `webstorm`'s. These
  are mechanical, need no research, and doing them in the spine costs one commit.
- **Zed, Warp and Obsidian each emit a fragment.** Agent writes
  `src/shared/catalogue/catalogue-<app>.json` — a standalone `{"<action-id>": "<command>"}`
  map, a new file nobody else touches — and ticket **26** folds all three into
  `catalogue.json` in one serial pass and deletes the fragments.

This is the decision that makes the parallelism real rather than nominal.

## Wave plan

```
Wave 1  ── serial ──────────────────────────────────────────────
  20  Thirteen app ids, descriptors, categories, stubs, seeding
              │
Wave 2  ── five worktrees, fully file-disjoint ─────────────────
        ├── 21  IntelliJ + PyCharm      (jetbrains.ts)
        ├── 22  Kiro + Antigravity      (vscode.ts)
        ├── 23  Zed adapter             (zed.ts)
        ├── 24  Warp adapter            (warp.ts)
        └── 25  Obsidian adapter        (obsidian.ts)
              │
Wave 3  ── serial ──────────────────────────────────────────────
  26  Fold the catalogue fragments in
  27  Thirteen columns: the table and the Apps page at scale
```

Wave 2 tickets 21 and 22 are small. They are listed separately because they are
genuinely disjoint (`jetbrains.ts` vs `vscode.ts`, different fixture directories), but
handing both to one agent is reasonable if you would rather run four worktrees than
five.

### Why these five do not collide

| Ticket | Files it owns |
| --- | --- |
| 21 | `adapters/jetbrains.ts`, `adapters/jetbrains.test.ts`, `__fixtures__/jetbrains/` |
| 22 | `adapters/vscode.ts`, `adapters/vscode.test.ts`, `__fixtures__/vscode/` |
| 23 | `adapters/zed.ts`, `adapters/zed.test.ts`, `__fixtures__/zed/`, `catalogue-zed.json` |
| 24 | `adapters/warp.ts`, `adapters/warp.test.ts`, `__fixtures__/warp/`, `catalogue-warp.json` |
| 25 | `adapters/obsidian.ts`, `adapters/obsidian.test.ts`, `__fixtures__/obsidian/`, `catalogue-obsidian.json` |

No two rows share a path. Merges into `main` after Wave 2 should be conflict-free in
every order.

## Running it

Wave 1 on `main`, then one worktree per Wave 2 ticket, branched off the spine commit:

```bash
# after 20 is committed on main
for t in jetbrains vscode zed warp obsidian; do
  git worktree add ../unikeys-$t -b feat/apps-$t main
done
```

Each worktree needs its own `npm install` (Electron's native deps are per-checkout).
Alternatively hand each ticket to an Agent with `isolation: "worktree"` and let the
harness create and clean up the checkout.

Every Wave 2 agent gets the same closing instruction:

> Implement `.scratch/unikeys-apps/issues/<N>-<name>.md` and nothing else. Touch only
> the files that ticket lists as yours. Read `README.md` and an existing adapter of a
> comparable format before you start — `ghostty.ts` for line-oriented text, `vscode.ts`
> for JSON, `iterm2.ts` for a file unikeys owns outright. `npm test`,
> `npm run typecheck` and `npm run lint` must all pass before you report done. Commit
> on your branch; do not merge.

## Tickets

| # | File | Wave | Status |
| --- | --- | --- | --- |
| 20 | `issues/20-thirteen-app-ids.md` | 1, serial | done — `af9e744` |
| 21 | `issues/21-intellij-and-pycharm.md` | 2, worktree | done — merged `1924dbd` |
| 22 | `issues/22-kiro-and-antigravity.md` | 2, worktree | done — merged `2a6f9de` |
| 23 | `issues/23-zed-adapter.md` | 2, worktree | done — merged `21bd84f` |
| 24 | `issues/24-warp-adapter.md` | 2, worktree | in progress |
| 25 | `issues/25-obsidian-adapter.md` | 2, worktree | in progress |
| 26 | `issues/26-catalogue-integration.md` | 3, serial | not started |
| 27 | `issues/27-thirteen-columns.md` | 3, serial | not started |

## Verification asymmetry — say it out loud

The repo's standing caveat is that most fixtures were authored from documented formats
rather than captured from a real Mac. This work does not fix that, and mostly extends
it:

| App | Installed here | Fixture provenance |
| --- | --- | --- |
| Antigravity | yes | **capturable** — real `keybindings.json` confirmed at `~/Library/Application Support/Antigravity/User/keybindings.json` |
| Kiro | yes | **capturable** — `User/` exists, no `keybindings.json` yet, which is the `config-not-created` path the code already handles |
| IntelliJ IDEA | no | authored |
| PyCharm | no | authored |
| Zed | no (a stray `~/.config/zed/settings.json` exists, no app) | authored |
| Warp | no | authored |
| Obsidian | no | authored |

Every new `__fixtures__/<app>/` directory needs a `README.md` saying which of these it
is, matching the existing ones.

## Landmines, indexed to their ticket

- **20** — two exhaustive unions have to widen in the spine or they break a file
  someone else owns: `AppHealth` gains `config-path-required` (for Obsidian, ticket 25)
  because `HEALTH_LABELS` in `AppsPage.tsx` is a `Record` keyed by it, and the test
  suite's hand-listed six apps (`view.test.ts` `ALL_APPS`, and the exact-list assertions
  at lines 203 and 247) go red the moment `APP_IDS` grows.
- **21** — `jetbrainsAdapter.apps` is `['webstorm']` and `defaults(app)` early-returns
  `unavailable` for anything else; `DEFAULTS_NOTE` says "WebStorm" in user-visible
  text. Config paths need `IntelliJIdea*` *and* `IdeaIC*`, `PyCharm*` *and*
  `PyCharmCE*` — `configPaths` is tried in order, so listing both works.
- **22** — nothing structural. `vscodeAdapter.apps` grows to four. Its curated defaults
  are shared across all four forks; both Kiro and Antigravity are Code OSS forks, so
  that is right, but Antigravity's real file shows fork-specific commands
  (`composerMode.agent`) that unikeys must leave alone — which the surgical merge
  already does.
- **23** — Zed's keymap is chord→action, the inverse of every other format here. The
  adapter has to invert on parse, and `merge` should own one appended block rather
  than editing the user's context blocks (later blocks win in Zed, so an owned trailing
  block is both safe and effective — the same shape as the iTerm2 dynamic profile).
- **24** — merge textually, line by line, like `ghostty.ts`. Do not add a YAML
  dependency and do not parse-and-reserialise; the round-trip guarantee in `README.md`
  forbids it.
- **25** — Obsidian's config lives inside a vault, so there is **no** standard
  `configPaths`. Check what `resolveConfigPath` and `diagnose` do with an empty
  `configPaths` array: the message renders as `"Looked in: "` with an empty join, which
  is a user-facing hole the ticket must close. Also `Mod` is Cmd on macOS — canonical
  `cmd` → `Mod`, canonical `ctrl` → `Ctrl`, and getting that backwards silently binds
  the wrong key.
- **27** — `createEmptyStore()` sets `enabled: true` for every `APP_ID`, and
  `deserializeStore()` starts from that base, so an existing store gains seven enabled
  columns on upgrade — most of them apps the user does not have. Seeding from
  `isInstalled` cannot go in `createEmptyStore()`: that function is in `src/shared/` and
  `isInstalled` touches the filesystem. It belongs in the main process at load time.

## Out of scope

Conflict detection across thirteen apps, per-vault Obsidian discovery beyond a manual
path, Warp's Linux config location, Zed's Vim-mode contexts, and JetBrains keymaps
other than the macOS one.
