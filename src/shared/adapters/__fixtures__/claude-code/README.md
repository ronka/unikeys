# Claude Code fixtures

Unlike Codex, this format is Anthropic's officially documented, versioned
public contract — [code.claude.com/docs/en/keybindings](https://code.claude.com/docs/en/keybindings),
accessed 2026-08-26. `claude --version` on the machine this plan was executed
on reported `2.1.246`, well past the plan's required `2.1.18` and past every
version-gated note in the docs (the `Doctor` context removed before v2.1.205,
`permission:toggleDebug`'s old default removed in v2.1.146, the `Task` chord
since v2.1.169, `selection:clear` since v2.1.234, `footer:dismiss` since
v2.1.217) — no version skew to reconcile.

## What was live-verified, and how

Driving `/keybindings` interactively through its full GUI flow was avoided —
see the plan's Step 1 note on why an unattended nested session is a risk not
worth taking against a real, authenticated Claude Code install. Everything
below instead came from writing a real `~/.claude/keybindings.json`,
launching a real `claude --debug` session non-interactively (`--debug` writes
structured validation output to `~/.claude/debug/<session>.txt` regardless of
interactive TUI use), reading the resulting log, and then **deleting the file
again** to leave the machine exactly as it was (no `~/.claude/keybindings.json`
existed before or after these experiments).

- **Duplicate context blocks are merged, with a warning, and the last one
  wins.** Confirmed directly from a real debug log after loading a file with
  two separate `"context": "Chat"` blocks binding the same key to different
  actions:

  ```text
  [DEBUG] [keybindings] Loaded 2 user bindings from /Users/.../keybindings.json
  [DEBUG] [keybindings] Found 1 validation issue(s)
  [WARN] [keybindings] [warning] Duplicate binding "ctrl+e" in Chat context — Previously bound to "chat:externalEditor". Only the last binding will be used.
  [DEBUG] [keybindings] KeybindingSetup initialized with 182 bindings, 1 warnings
  ```

  This resolves the one thing the plan flagged as "a capture question, not an
  assumption": multiple blocks sharing a context are *not* rejected and are
  *not* first-wins — they merge, and the last value written for a given
  keystroke inside that merged context wins. This also matches
  `member()` in `./jsonc`, which already implements "later member wins" for a
  duplicate JSON object key — the same convention, applied by Claude Code
  across blocks rather than within one.

- **A well-formed custom file loads with zero warnings and is watched live**,
  confirmed from the same kind of debug log for a clean file:

  ```text
  [DEBUG] [keybindings] Loaded 3 user bindings from /Users/.../keybindings.json
  [DEBUG] [keybindings] KeybindingSetup initialized with 183 bindings, 0 warnings
  [DEBUG] [keybindings] Watching for changes to /Users/.../keybindings.json
  ```

- **A reserved shortcut produces an exact, quotable error**, confirmed by
  attempting to rebind `ctrl+c`:

  ```text
  [WARN] [keybindings] [error] "ctrl+c" may not work: Cannot be rebound - used for interrupt/exit (hardcoded)
  ```

  This is the message `InexpressibleChord.reason` is modelled after for a
  reserved-shortcut conflict.

## Files

- `authored-clean.json` — the exact file used for the zero-warning, 183-binding
  live verification above: one plain binding (`ctrl+y` → `chat:stash`), one
  two-stroke chord (`ctrl+x ctrl+y` → `chat:undo`), and one default unbind
  (`ctrl+t` → `null` in `Global`, suppressing `app:toggleTodos`'s default).
- `authored-duplicate-context.json` — the exact file used for the duplicate
  warning above.
- `authored-reserved.json` — the exact file used for the reserved-shortcut
  error above.
- `authored-empty.json` — the documented empty-file shape from the docs
  (`$schema`, `$docs`, an empty `bindings` array), matching `emptyContents()`.
- `authored-unsupported.json` — an unknown context and an unknown action
  alongside valid bindings, for the "preserved and reported, never guessed"
  path.
- `malformed.json` — invalid JSON, for the file-level error path.

## `CLAUDE_CODE_ACTIONS`

Every compound token curated in `claude-code.ts` was read directly off the
live docs page's action tables (all 19 contexts), not guessed from a label.
`availability: 'complete'` on `defaults()` means complete for the **curated
catalogue surface** unikeys actually maps — not a claim that every one of
Claude Code's dozens of actions has a modelled default.
