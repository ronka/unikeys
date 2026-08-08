# unikeys

One table for every keybinding across VSCode, Cursor, WebStorm, Ghostty, cmux and iTerm2.

Each **row** is an action. Each **column** is an app. Each **cell** is the chord that
action is bound to in that app. Edit any cell, or **link** a row so every app that
supports the action shares one chord and stays in sync as you keep tweaking.

Saving writes into each app's real config file, surgically — only the actions
unikeys manages are touched, everything else is left exactly as it was, and each
file is backed up before its first write in a session.

macOS only. Personal local use; no code signing or distribution.

## Architecture

The layering exists to make the risky parts testable without mocking anything.

| Layer                 | Where                   | Rule                                                      |
| --------------------- | ----------------------- | --------------------------------------------------------- |
| Canonical chord model | `src/shared/chord.ts`   | One internal representation; app notation never leaks out |
| Adapters              | `src/shared/adapters/`  | Pure `string → string`. No filesystem, no Electron        |
| Action catalogue      | `src/shared/catalogue/` | Shipped data, validated at startup                        |
| Table reducer         | `src/shared/table/`     | Pure. Linked-row propagation lives here and nowhere else  |
| File + write pipeline | `src/main/`             | The only code that touches `fs`                           |
| UI                    | `src/renderer/src/`     | Pure UI behind a typed IPC surface                        |

Two consequences worth knowing:

- **Adapters are defined over strings, not files.** `parse(contents) → Binding[]` and
  `merge(contents, managed) → contents`. Every format risk is therefore testable with
  fixture strings and no mocking.
- **`merge` is textual and position-based**, not parse-and-reserialise. That is what
  lets unchanged content round-trip byte-identically and preserves comments, ordering
  and formatting.

## Commands

```bash
npm install
npm run dev         # run the app
npm test            # vitest, the pure modules
npm run typecheck   # main, renderer and tests
npm run lint
npm run build:mac
```

## Outstanding: most fixtures are authored, not captured

This repo was developed on Linux with none of the editor apps installed. The test
fixtures in `src/shared/adapters/__fixtures__/` and each adapter's shipped-defaults
table were **authored from the documented formats rather than captured from a real
Mac**. Each fixture directory has a `README.md` saying so.

**iTerm2 is the exception.** Its fixtures, action table and key encoding were captured
from a real iTerm2 3.6.11 — the action integers cross-checked against the bindings
shipped inside the app bundle, the key encoding and menu-item parameter settled by
driving the running app, and `captured-3.6.11.json` confirmed line by line to behave as
intended in a live session. See `__fixtures__/iterm2/README.md`.

The value of the adapter seam is entirely in matching reality, so before trusting
unikeys with a real config, replace the remaining fixtures with genuine captures from a
Mac and re-run `npm test`. Tickets 03 and 04 ask for exactly this.

Shipped defaults are a related gap: VSCode compiles its defaults into the application
and JetBrains ships them inside the app bundle, so both adapters carry a hand-authored
curated subset and report `availability: 'partial'`. Cells with no sourced default
start empty rather than wrong, and the limitation is surfaced in the Apps panel.

## Not in the MVP

Conflict detection, drift detection and re-import, user-defined actions, profiles,
two-way sync, non-macOS platforms, apps beyond the four, and auto-reloading the target
apps after a write. See `.scratch/unikeys-mvp/spec.md`.
