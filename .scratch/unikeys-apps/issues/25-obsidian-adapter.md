# 25 — Obsidian column

**What to build:** Replace the `obsidian-hotkeys` stub with a real adapter, and close
the hole its config location opens. Obsidian is the first app in the project whose
configuration does not live at a standard location at all: hotkeys are stored per
vault, at `<vault>/.obsidian/hotkeys.json`, and unikeys has no way to know where a
user's vault is. Ticket 20 gave it `configPaths: []` so the build would compile; this
ticket has to make that state read sensibly to a user.

**Blocked by:** 20.

**Status:** done — branch `feat/apps-obsidian`, commit `ad750e9`

**Files you own:** `src/shared/adapters/obsidian.ts`,
`src/shared/adapters/obsidian.test.ts`,
`src/shared/adapters/__fixtures__/obsidian/`,
`src/shared/catalogue/catalogue-obsidian.json`, and — narrowly, for the
manual-path work below — `src/main/config-files.ts` and `src/main/apps-service.ts`.
Do **not** edit `catalogue.json` (ticket 26) or any renderer file (ticket 27).

The `config-path-required` health variant and its `HEALTH_LABELS` entry already exist:
ticket 20 added them with a placeholder message, precisely so this ticket can land the
behaviour without touching `src/shared/ipc.ts` or `AppsPage.tsx`. Replacing the
placeholder message is a main-process change.

## The format

```json
{
  "editor:swap-line-down": [{ "modifiers": ["Alt"], "key": "ArrowDown" }],
  "workspace:split-vertical": [{ "modifiers": ["Mod", "Shift"], "key": "\\" }],
  "app:go-back": []
}
```

- The file holds **only the user's overrides**. Defaults live inside the application.
- A command maps to an *array* of bindings. unikeys shows and manages the first; leave
  any others alone, the way the JetBrains adapter leaves alternate shortcuts alone.
- An **empty array is an explicit unbind** that suppresses the shipped default. That is
  the `negated` binding, and getting it wrong means showing a chord the user removed.

## `Mod` is Cmd, not Ctrl

On macOS `Mod` is the Command key. Canonical `cmd` → `Mod`, canonical `ctrl` → `Ctrl`,
`alt` → `Alt`, `shift` → `Shift`. Decoding accepts `Mod` and `Meta` as `cmd`. Reversing
this silently binds the wrong key on every row, so cover both directions in tests.

Keys are DOM `KeyboardEvent.key` values: letters uppercase (`"T"`), arrows
`"ArrowDown"`, and `"Enter"`, `"Escape"`, `"Tab"`, `"Backspace"`, `"Delete"`, `"Home"`,
`"PageUp"`, `"F1"`, with space as `" "`. Map these to and from the canonical vocabulary
in `chord.ts` explicitly rather than by casing rules.

Obsidian has no two-keystroke sequences: reject a multi-stroke chord as an
`InexpressibleChord` with a clear reason.

## Merging

The file is strict JSON written by Obsidian itself, but it is the user's and holds
commands unikeys does not manage. Splice textually rather than reserialising —
`src/shared/adapters/jsonc.ts` already does this for the VSCode and cmux adapters, and
its object-member editing is what you want. Merging unchanged content must round-trip
byte-identically.

`emptyContents()` returns `{}`, which is a valid empty hotkeys file.

## Defaults

Obsidian's defaults are compiled into the application. Report
`availability: 'unavailable'` with a note, unless you can source a curated subset you
actually trust — in which case `partial`. Unoverridden cells starting empty is the
correct outcome here, and the Apps page already surfaces the limitation.

## The vault path — the real work

With `configPaths: []`, `resolveConfigPath` returns `null`, `readConfig` returns
`not-found` with an empty `searched`, and `diagnose()` renders
`"No config found. Looked in: "` — a sentence that trails off. Worse, `writeTarget`
finds no concrete candidate and falls through to a message telling the user to create a
config in the app, which is not the action that fixes this.

Close it properly:

- `diagnose()` must return `config-path-required` for an app with no `configPaths` and
  no override, instead of falling through to "No config found. Looked in: ".
- The message must say exactly what to point at: the `hotkeys.json` inside the vault's
  `.obsidian` directory, and that it may not exist until the user has set at least one
  hotkey in Obsidian.
- `writeTarget` for Obsidian with an override should accept a path to a `.obsidian`
  directory as well as to the file itself, resolving to `hotkeys.json` inside it — the
  same courtesy `resolveKeymapFile` extends to a JetBrains `keymaps` directory.
- With no override set, Obsidian must be read-only rather than writing anywhere. A save
  targeting it drops with a deliberate reason, the way a disabled app does.

Do not add vault auto-discovery. Guessing at `~/Documents` or an iCloud container is
out of scope and would be wrong more often than right.

## Catalogue fragment

`src/shared/catalogue/catalogue-obsidian.json`. Expect a *small* map. Obsidian is a
notes app: undo, copy and paste are native and have no command id, so those rows
correctly render as not-applicable. Realistic candidates are the navigation and window
rows — quick switcher, command palette, split, go back/forward, close tab. Omit rather
than invent.

If the fragment ends up mapping only a handful of the 38 actions, that is the honest
answer and not a failure of the ticket.

## Fixtures

Obsidian is not installed on this machine, so fixtures are authored from the documented
format. Write `__fixtures__/obsidian/README.md` saying so. Cover at minimum: a
populated hotkeys file, one with an empty-array unbind, one with several bindings for a
single command, one with a `Mod`+`Ctrl` mix, an empty `{}`, and a malformed file.

## Definition of done

- [ ] The table shows an Obsidian column — renderer work, lands with ticket 27; Obsidian is not installed here so this stays unobserved
- [x] `Mod` maps to Cmd and `Ctrl` maps to Ctrl, in both directions, under test
- [x] An empty binding array reads as an explicit unbind, not as an unmentioned command
- [x] Extra bindings for a managed command survive a merge untouched
- [x] Merging unchanged content round-trips byte-identically
- [x] With no path configured, the Apps page says what to point at and where to find it, and no save writes anywhere
- [x] An override naming a `.obsidian` directory resolves to `hotkeys.json` inside it
- [x] `catalogue-obsidian.json` exists and maps only actions Obsidian really has
- [x] `npm test`, `npm run typecheck` and `npm run lint` pass
