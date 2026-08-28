# Codex fixtures

**Provenance: static binary verification, not a live GUI capture.**

Everything below was verified by reading `/Applications/ChatGPT.app/Contents/Resources/app.asar`
directly (a static inspection of the installed, shipped bundle — never a runtime
`.asar` extraction from unikeys itself, which stays out of scope per the plan).
No fixture here was produced by clicking through Settings > Keyboard Shortcuts
in a running ChatGPT, because that step requires a native macOS GUI this
project's tooling cannot drive. If you can run through that flow by hand, please
replace `authored-populated.json` with a real `captured-<version>.json` and
delete this caveat — that remains the better source.

- **App version pinned**: ChatGPT.app `26.820.60940` (`CFBundleVersion` `7119`),
  confirmed installed and exactly matching the plan's pin on 2026-08-26 via
  `defaults read .../Info.plist CFBundleShortVersionString`.
- **File name and location**: `keybindings.json`, confirmed literally in the
  bundle as `EZ=\`keybindings.json\`` alongside
  `env.CODEX_HOME??join(homedir(),'.codex')` — i.e. `$CODEX_HOME/keybindings.json`
  falling back to `~/.codex/keybindings.json`, exactly as the plan states.
- **Schema**: confirmed as the zod schema
  `vp.object({command: vp.string(), key: vp.string().nullable()})`, array of
  that object (`kZ=vp.array(OZ)`), parsed with a bare `JSON.parse` — Codex's own
  reader is **strict JSON**, not JSONC. It does not tolerate comments or
  trailing commas; a hand-added comment would make Codex itself fail to read
  the file and fall back to no overrides. unikeys' own parser is still the
  shared tolerant JSONC reader (`./jsonc`), per the repository's general
  preservation convention — it only means a comment *unikeys* preserves is one
  *Codex* would choke on, and that mismatch is a known, accepted gap rather
  than a claim that Codex supports comments.
- **Write serialization**: confirmed directly in the bundle:
  `writeFile(e, JSON.stringify(ZZ(t), null, 2) + '\n')` where
  `ZZ(e) = [...e].sort((e,t) => e.command.localeCompare(t.command))` — i.e. the
  app's own writer sorts by command and pretty-prints with two spaces and a
  trailing newline, exactly as the plan states. unikeys deliberately does
  **not** reproduce this sort — see the adapter's module comment for why.
- **Legacy migration map**: confirmed verbatim in the bundle as
  `DZ={closeTabOrWindow:[\`closeTab\`,\`closeWindow\`],newThread:\`newTask\`,toggleSidePanelFullWidth:\`toggleMaximizeSidePanel\`}`.
  All three migrations are exercised in `codex.test.ts`.
- **Command ids and labels curated below**: each id was found verbatim in the
  command registry (`cZ=[...]`) and its visible label was read from the
  `defaultMessage` English source strings (a react-intl-style catalog embedded
  in the same bundle, independent of the runtime `titleIntlId` lookup used for
  translated locales). Cross-checked against OpenAI's public
  [Commands reference](https://learn.chatgpt.com/docs/reference/commands)
  (accessed 2026-08-26), which independently confirms the same labels and
  default shortcuts for every command it documents:

  | Command id                   | Label                | Default (macOS)     | Confirmed by OpenAI docs |
  | ----------------------------- | -------------------- | -------------------- | ------------------------ |
  | `newTask`                     | New chat              | `Cmd+N` (alt `Cmd+Shift+O`) | yes ("New chat") |
  | `composer.submit`              | Send message          | *(none — Enter is hardcoded, not in this file)* | yes (documented as not customizable) |
  | `composer.openModelPicker`     | Open model picker     | `Ctrl+Shift+M` (literal Control, not remapped to Cmd) | yes, same shortcut |
  | `closeTab`                     | Close Tab             | `Cmd+W`               | — |
  | `nextTab`                      | Next tab              | `Cmd+Shift+]`          | — |
  | `previousTab`                  | Previous tab          | `Cmd+Shift+[`          | — |
  | `toggleTerminal`               | Open terminal         | `Control+\`` (literal Control) | — |

  Two commands the plan's catalogue step (`agent.newline`, `agent.interrupt`)
  hoped might map to Codex **do not exist** in the 120-id command registry at
  all — there is no configurable "insert newline" or "interrupt/stop response"
  command; Enter-to-send and Escape-to-stop are hardcoded, matching OpenAI's
  docs, which list no shortcut for either. `agent.toggle-transcript` also has
  no clean Codex equivalent (the closest ids, `toggleReviewTab` /
  `togglePriorityFilter` / `toggleBottomPanel`, are a code-review panel and an
  activity/notifications view, not a conversation transcript). All three are
  mapped to Claude Code only — see `../claude-code/README.md`.

- **`CODEX_COMMAND_IDS`** in `codex.ts` lists only the ids actually curated
  above, not the full 120-id registry — everything else in Codex's command
  surface has no unikeys default and is treated as an ordinary unmanaged entry
  if a user's file happens to mention it.

## Files

- `authored-empty.json` — the normalized empty-file shape (`[]\n`), matching
  `emptyContents()`.
- `authored-populated.json` — a hand-authored file exercising a bound command,
  an explicit `key: null` unbind, a command with two alternate bindings, an
  unmanaged/unknown command, and all three legacy migration aliases. Labelled
  authored because it was not captured from a live customization.
- `malformed-json.json` — invalid JSON syntax, for the file-level error path.
- `malformed-root.json` — valid JSON but not an array, for the same path.
- `malformed-entries.json` — a valid array containing entries with a missing
  command, a non-string/non-null key, and a non-object item, alongside valid
  entries — for the "problem, not file failure" path.

## What could not be verified without the GUI

- Whether ChatGPT needs a full restart to pick up an externally-written
  `keybindings.json` while running, or reflects it immediately (unclear from
  static analysis; `reloadHint` in `apps.ts` says restart to be conservative
  until someone confirms otherwise).
- Whether the Settings > Keyboard Shortcuts UI actually permits assigning two
  alternate bindings to one command through the UI (the file format and the
  `append` update-kind in the bundle both support it; only the UI's own limits
  are unconfirmed).
