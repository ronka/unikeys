# dev-home — a home directory with all fifteen apps in it

This tree is a stand-in macOS home directory. Every app unikeys supports has its
config file here, at the exact path `APPS` looks for it, plus a stand-in
`.app` bundle under `Applications/` so install detection finds it. Nothing in
here is installed and nothing needs to be.

```bash
npm run dev:apps            # run unikeys against this tree
npm run dev:apps -- --keep  # reuse the last run's working copy instead of a fresh one
npm run dev:apps -- --dmg   # dmg build behaviour, instead of the simulated sandbox
```

The run **copies** this tree to `.dev-home/home/` (gitignored) and points the app
there, so saving writes to the copy and the repo stays clean. Every run starts
from a fresh copy unless you pass `--keep` — which is what makes the first-save
path repeatable rather than a thing you can only test once. A store seeded from
`tools/dev-home/store.seed.json` goes in `.dev-home/userData/`.

Backups follow the build being simulated, because that is a real difference
between the two: under the default simulated sandbox they go to the folder the
store names, `.dev-home/home/unikeys-backups/`, and under `--dmg` they go to
`.dev-home/userData/backups/` — the seeded folder is ignored, which is exactly
what `backupsDirectory` does outside the sandbox.

Two environment variables do the work, and both are inert in a packaged build:
`UNIKEYS_DEV_HOME` is what `realHome()` returns, and `UNIKEYS_DEV_USER_DATA` is
what `index.ts` redirects `app.getPath('userData')` to. `src/main/dev-home.test.ts`
walks this tree through the real `readConfig` and fails if any app stops
resolving — including the next app added to `APP_IDS`, on the day it is added.

## Provenance: authored, with two exceptions

**Most of these files were authored from the documented formats, not captured
from a real install** — the same caveat the root README carries about
`src/shared/adapters/__fixtures__/`, and for the same reason. They are written
to be faithful, and faithful-by-authorship is not the same as genuine. Where a
real capture existed it was used.

| Path | Provenance |
| --- | --- |
| `Library/Application Support/iTerm2/DynamicProfiles/unikeys.json` | **Real, but unikeys' own.** Byte for byte `__fixtures__/iterm2/captured-3.6.11.json`, which is a Dynamic Profile unikeys wrote and was then confirmed line by line to behave as intended in a live iTerm2 3.6.11. That makes it verified against a real app — not a capture of a config someone else had, which is what the Antigravity row is. |
| `Library/Application Support/Antigravity/User/keybindings.json` | **Captured then extended.** The header, the four-space indent, the absent trailing newline and the `composerMode.agent` entry are real, from Antigravity 1.16.5. Four mapped bindings were appended, because the capture's one binding is a fork-only command the catalogue does not map — on its own it gives an empty column. `__fixtures__/vscode/captured-antigravity.json` is the pristine copy. |
| `.config/cmux/cmux.json` | Authored, over the real `template-0.64.22.jsonc` header. |
| `.codex/keybindings.json` | **Authored, asar-verified.** Codex's schema, command ids, and default shortcuts were confirmed by statically reading the installed ChatGPT.app `26.820.60940` bundle — not by clicking through its Settings UI, which nothing here can drive. See `src/shared/adapters/__fixtures__/codex/README.md`. |
| `.claude/keybindings.json` | **Authored, live-verified.** The schema is Anthropic's public contract; the specific bindings here were exercised against a real, running `claude --version 2.1.246` and confirmed to load with the expected warnings (or none) before this file was written. See `src/shared/adapters/__fixtures__/claude-code/README.md`. |
| everything else | Authored. |

The chords **disagree across apps on purpose.** VSCode splits on `cmd+d`, Cursor
on `cmd+\`, Zed on `cmd+alt+right`, IntelliJ on `alt+cmd+v` — because a table
where every row already agrees gives Match nothing to do, and reconciling that
disagreement is what unikeys is for.

## States worth having a column in

Not every app is in the happy path, deliberately:

- **Kiro** has `User/` with no `keybindings.json` — the `config-not-created`
  state, where unikeys' first save creates the file. This is what Kiro actually
  looks like until you change a binding.
- **iTerm2** already holds a unikeys Dynamic Profile, so it starts in the state
  an app is in *after* a first save. Delete the file in the working copy to see
  the state before one.
- **Obsidian** has no standard config location, so its column only resolves
  through the `configPath` in the seeded store, pointing at `Vaults/Demo/`.
  Clear it to see the `config-path-required` state.
- **Warp** and **Ghostty** each carry one entry unikeys cannot model — Warp's
  `meta` modifier, Ghostty's `global:` trigger prefix. Both should be reported
  as skipped on import and survive a save untouched.
- **JetBrains** has one versioned directory per IDE with one keymap `.xml`
  inside. Add a second version directory to exercise `expandGlob` picking the
  newest.
- **Codex**'s first-save creation path (a fresh `[]\n` file) is not
  represented here on purpose — `.codex/keybindings.json` is populated so the
  column has something to show. Delete it from the working copy
  (`.dev-home/home/.codex/keybindings.json`) to see that path instead.
- **Claude Code**'s live reload and null-default unbind behavior are best
  exercised against a real install, not this tree: point a real
  `claude --debug` session's `HOME` at a scratch copy of
  `.claude/keybindings.json`, edit it while the session is open, and confirm
  the debug log reports the change with no warnings — see
  `src/shared/adapters/__fixtures__/claude-code/README.md` for exactly that
  evidence already captured once.

To see the onboarding wizard, set `onboardingCompleted` to `false` in
`tools/dev-home/store.seed.json`, or delete `.dev-home/userData/`.

## Replacing an authored file with a real one

Copy the real config over the file at the same path here, scrub anything
personal, move its row in the table above to **Captured**, and run
`npm test`. Anything that breaks is a real assumption the adapter got wrong —
treat the capture as right and the test as wrong.
