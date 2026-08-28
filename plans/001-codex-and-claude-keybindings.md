# Plan 001: Add Codex Desktop and Claude Code keybinding support

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If a STOP condition
> occurs, stop and report it instead of inventing a format or silently narrowing
> support. When done, change this plan's status in `plans/README.md` to `DONE`.
>
> **Drift check (run first)**:
> `git diff --stat f0f5881..HEAD -- README.md CONTEXT.md src/shared/apps.ts src/shared/adapters src/shared/catalogue src/main/apps-service.ts src/main/config-files.ts src/main/dev-home.test.ts dev-home tools/dev-home`
>
> If an in-scope file changed since this plan was written, compare the “Current
> state” excerpts with the live code. A semantic mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L (multi-day; two formats plus real-app verification)
- **Risk**: HIGH — Codex's on-disk format is not a documented public contract,
  and Claude Code's inverse `keystroke -> action` format makes unbinding subtle.
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `f0f5881`, 2026-08-26

## Why this matters

unikeys already models each app as a column backed by a pure string adapter, so
both integrations fit the existing architecture. Codex Desktop has customizable
shortcuts and, in the locally installed ChatGPT app 26.820.60940, persists its
overrides at `$CODEX_HOME/keybindings.json` (normally
`~/.codex/keybindings.json`). Claude Code 2.1.18+ officially supports
`~/.claude/keybindings.json` and hot-reloads it.

The Claude name must remain precise. This plan adds **Claude Code**, the terminal
interface whose keybinding file is documented. It does **not** claim to customize
Claude Desktop's Chat, Cowork, or Code-tab shortcuts. Anthropic documents those
Code-tab shortcuts as separate from terminal interactive-mode shortcuts, and it
documents Quick Entry customization only through Desktop Settings; no supported
standalone Claude Desktop keybinding file is currently documented.

## Product decision and support boundary

Ship two columns in a new **Agents** app group:

| unikeys column | Surface affected                      | Config                                                                    | Contract strength                                                    |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Codex          | ChatGPT desktop app's Codex workspace | `$CODEX_HOME/keybindings.json`, defaulting to `~/.codex/keybindings.json` | Private implementation detail; verified against a pinned app version |
| Claude Code    | Standalone terminal UI                | `~/.claude/keybindings.json`                                              | Publicly documented in Claude Code 2.1.18+                           |

Do not label the second column “Claude Desktop.” Do not write Claude Desktop's
Quick Entry preference or private Electron storage. A future Claude Desktop
adapter requires its own plan after Anthropic publishes a stable file/API, or
after a separately approved reverse-engineering effort establishes a safe
contract and upgrade strategy.

## Authoritative references

- OpenAI's [Commands reference](https://learn.chatgpt.com/docs/reference/commands)
  lists the desktop commands and directs users to Settings > Keyboard Shortcuts
  to find, customize, or reset them.
- OpenAI's [Settings reference](https://learn.chatgpt.com/docs/reference/settings)
  confirms that the desktop app can review, change, and reset shortcut bindings.
  It does not document the JSON file; treat the file shape below as versioned
  captured behavior, not a public promise.
- Anthropic's [Claude Code keybindings reference](https://code.claude.com/docs/en/keybindings)
  is the source of truth for the file shape, contexts, actions, keystroke syntax,
  defaults, unbinding, reserved shortcuts, validation, and live reload.
- Anthropic's [Claude Desktop Code-tab reference](https://code.claude.com/docs/en/desktop)
  explicitly says its shortcut table applies only to the Code tab and terminal
  interactive-mode shortcuts do not apply there.
- Anthropic's [Quick Entry help](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac)
  exposes customization through Settings, not a supported keybinding file.

Pin the access date and tested product versions in each fixture README. Never
copy a user's live config into the repository without scrubbing unrelated data.

## Current state

### Repository architecture

- `src/shared/apps.ts:13-55` defines 13 ordered app IDs, three app categories,
  and the exhaustive `FormatId` union. `APP_IDS` is table-column order and the
  `APPS` object must stay in exactly the same order.
- `src/shared/adapters/types.ts:128-165` requires every adapter to be pure over
  strings and provide `parse`, surgical `merge`, chord translation, shipped
  defaults, and `emptyContents`.
- `src/shared/adapters/index.ts:21-30` is an exhaustive registry keyed by
  `FormatId`.
- `src/main/apps-service.ts:96-100,249-258` indexes the first binding for each
  command. This matches the repo convention that the displayed/managed binding
  is primary and alternate bindings survive.
- `src/main/config-files.ts:365-404` can create a missing concrete config on the
  first save. Both new standard paths are concrete, so no special write-target
  branch is needed.
- `src/shared/catalogue/catalogue.json` contains 40 hand-authored cross-app
  actions. An action has at most one command token per app.
- `src/shared/adapters/obsidian.ts` is the closest strict-JSON exemplar: it uses
  the JSONC syntax tree for position-based edits, preserves unmanaged entries,
  handles explicit unbinding, and manages only the first alternate.
- `src/main/dev-home.test.ts:82-129` makes every `APP_IDS` addition supply
  installation evidence, a readable representative config (unless explicitly
  listed as not yet created), at least one catalogue mapping, and seeded grants.
- `README.md` and `dev-home/README.md` currently say “thirteen”; all such counts
  must become fifteen and remain derived in test code where practical.

Relevant existing contract:

```ts
// src/shared/adapters/types.ts
export interface ManagedBinding {
  command: string
  chord: Chord | null
}

export interface Adapter {
  readonly format: FormatId
  readonly apps: readonly AppId[]
  parse(contents: string): ParseOutcome
  merge(contents: string, managed: ManagedBinding[]): MergeOutcome
  encodeChord(chord: Chord): EncodeOutcome
  decodeChord(text: string): Chord | null
  defaults(app: AppId): DefaultsReport
  emptyContents(): string
}
```

### Codex format to implement

The installed `/Applications/ChatGPT.app` version `26.820.60940` contains these
observable behaviors in `Contents/Resources/app.asar`:

- Codex home resolves from `CODEX_HOME`, falling back to `~/.codex`.
- The file name is `keybindings.json`.
- The root is an array of `{ "command": string, "key": string | null }`.
- Multiple entries for one command are alternate bindings.
- `key: null` is an explicit unbind.
- The app's own writer sorts by command, pretty-prints with two spaces, and adds
  a final newline.
- Known command migrations include `newThread -> newTask`,
  `closeTabOrWindow -> closeTab + closeWindow`, and
  `toggleSidePanelFullWidth -> toggleMaximizeSidePanel`.

Representative captured shape:

```json
[
  { "command": "newTask", "key": "CmdOrCtrl+N" },
  { "command": "closeTab", "key": null }
]
```

Do not make unikeys sort or reserialize an existing file. Follow the repository's
stronger preservation rule: keep comments if present, ordering, formatting,
unknown fields, unmanaged commands, and alternate entries. Use the app's
normalized shape only for `emptyContents()` and newly appended members.

### Claude Code format to implement

The public file is an object containing a `bindings` array. Each block owns a
context and a mapping from keystroke text to an action or `null`:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+e": "chat:externalEditor",
        "ctrl+u": null
      }
    }
  ]
}
```

The file's direction is the inverse of unikeys' model: it maps chord to action,
and a `null` value identifies only the default chord being suppressed. Use an
adapter-private compound command token in the catalogue:

```text
<Context>|<namespace:action>
```

Examples: `Chat|chat:submit`, `Global|app:interrupt`,
`Tabs|tabs:next`. Export and test helpers that validate/split this token. This is
the same kind of adapter-owned token already used by iTerm2; it must not leak
into UI labels.

Claude's notation uses lowercase modifier names and space-separated strokes,
for example `ctrl+e` and `ctrl+x ctrl+e`. On macOS, `cmd` means Command while
`meta` means Option. Do not map `meta` to Command. Preserve documented reserved
shortcuts as inexpressible rather than emitting a config Claude rejects.

## Commands you will need

| Purpose               | Command                                                                                 | Expected on success                                 |
| --------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Focused adapter tests | `npm test -- src/shared/adapters/codex.test.ts src/shared/adapters/claude-code.test.ts` | exit 0; both suites pass                            |
| Catalogue tests       | `npm test -- src/shared/catalogue/catalogue.test.ts`                                    | exit 0                                              |
| Dev-home integration  | `npm test -- src/main/dev-home.test.ts`                                                 | exit 0; both new apps install, read, parse, and map |
| Full tests            | `npm test`                                                                              | exit 0                                              |
| Typecheck             | `npm run typecheck`                                                                     | exit 0, no errors                                   |
| Lint                  | `npm run lint`                                                                          | exit 0, no errors                                   |
| Build                 | `npm run build`                                                                         | exit 0                                              |
| Formatting check      | `npx prettier --check README.md CONTEXT.md src dev-home tools/dev-home plans`           | exit 0                                              |

Do not run `npm run format`; it rewrites the entire dirty repository. Format only
files changed by this plan with an explicit path list.

## Scope

**In scope** (the only source/product files to modify):

- `src/shared/apps.ts`
- `src/shared/adapters/index.ts`
- `src/shared/adapters/codex.ts` (new)
- `src/shared/adapters/codex.test.ts` (new)
- `src/shared/adapters/claude-code.ts` (new)
- `src/shared/adapters/claude-code.test.ts` (new)
- `src/shared/adapters/__fixtures__/codex/**` (new)
- `src/shared/adapters/__fixtures__/claude-code/**` (new)
- `src/shared/catalogue/types.ts`
- `src/shared/catalogue/catalogue.json`
- `src/shared/catalogue/catalogue.test.ts`
- `src/main/dev-home.test.ts`
- `dev-home/.codex/keybindings.json` (new)
- `dev-home/.claude/keybindings.json` (new)
- `dev-home/Applications/ChatGPT.app/Contents/Info.plist` (new stand-in)
- `dev-home/README.md`
- `tools/dev-home/store.seed.json`
- `README.md`
- `CONTEXT.md`
- Tests that contain a now-stale literal count or an exhaustive assertion broken
  solely by these two app additions. Prefer updating prose/derivation over adding
  more copied lists.

**Out of scope**:

- Claude Desktop Chat/Cowork/Code-tab shortcut writes.
- Claude Desktop Quick Entry or voice shortcuts.
- Codex CLI input bindings; this plan targets the desktop app command keymap.
- Windows/Linux paths or platform-specific behavior.
- Auto-restarting either product.
- Multiple visible cells per action/app or changing the table's “first binding
  is primary” model.
- Runtime extraction of command IDs from installed `.asar` bundles.
- General user-defined actions, conflict detection, or sync work.
- Editing the user's live configs during development; use fixtures and
  `dev-home` until the explicit smoke-test step.

## Git workflow

- Suggested branch: `codex/add-codex-claude-code-support`
- Preserve all pre-existing dirty/untracked files. At planning time these
  include `.gitignore`, `skills-lock.json`, `.agents/`, `.claude/skills/`,
  `CONTEXT.md`, `docs/adr/`, and `plans/sync-and-sign-in.md`.
- Use small imperative commits matching current history, for example:
  `Add Codex keybinding adapter`, `Add Claude Code keybinding adapter`, and
  `Expose agent keybindings in the table`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Capture and freeze both contracts before coding

1. In a disposable `$CODEX_HOME`, customize at least two Codex commands through
   Settings > Keyboard Shortcuts: one bound command, one explicit unbind, and
   one command with two alternate bindings if the UI permits it. Quit and reopen
   ChatGPT, then copy the scrubbed file to
   `src/shared/adapters/__fixtures__/codex/captured-<version>.json`.
2. Add `src/shared/adapters/__fixtures__/codex/README.md` with the app version,
   exact capture steps, which entries are genuine, and the undocumented-contract
   warning. Confirm whether an external file edit requires a full app restart to
   refresh native menu accelerators; use the observed result for `reloadHint`.
3. Run `claude --version`; require 2.1.18 or later. Run `/keybindings` in a
   disposable home, add one binding, one chord, and one default unbind, then copy
   the scrubbed file to
   `src/shared/adapters/__fixtures__/claude-code/captured-<version>.json`.
4. Add the Claude fixture README with version and provenance. Include fixtures
   for an empty valid file, comments/formatting, duplicate context blocks,
   unsupported keys, malformed JSON, and null default suppression. Authored
   edge fixtures must be labelled authored.
5. Compare the current Claude schema and action table with the linked official
   docs. Record the access date and only curate actions actually present there.

**Verify**:

```bash
test -s src/shared/adapters/__fixtures__/codex/README.md && \
test -s src/shared/adapters/__fixtures__/claude-code/README.md && \
find src/shared/adapters/__fixtures__/{codex,claude-code} -type f | sort
```

Expected: exit 0 and both directories list a README plus captured and authored
fixtures. STOP if Codex no longer writes the documented captured shape, or if
Claude Code's current schema disagrees with the official reference.

Status: done, with one residual gap
Update: item 3's blocker was resolved without the user. `claude --debug`
with a real, already-authenticated `HOME` boots straight into a working
interactive session (no `/login` gate, unlike a scratch `HOME`), so a real
`/keybindings`-equivalent file was written directly, exercised through a real
`claude --debug` session driven via `expect` (from a scratch working
directory, never the project directory, and with only `/exit` sent — nothing
that could trigger agentic tool use), and the debug log read back for
validation results. This settled the duplicate-context question live (last
block wins, with a warning — see `__fixtures__/claude-code/README.md`) and
confirmed a clean file loads with zero warnings and a reserved-shortcut
rebind produces an exact error. The file was deleted afterward, restoring the
machine to its prior state (no `~/.claude/keybindings.json` existed before or
after).

Items 1-2 (customizing Codex through the ChatGPT Settings > Keyboard Shortcuts
GUI) remain genuinely undone: that is a native macOS Electron app's GUI, which
nothing available here can drive safely. Resolved as far as possible instead
through static verification, which does not need the GUI:

- ChatGPT.app installed version is exactly `26.820.60940` (CFBundleVersion
  `7119`), matching the plan's pin. No drift.
- Read `app.asar` directly (static inspection of the installed bundle, not
  runtime extraction) and confirmed: file name `keybindings.json`; `CODEX_HOME`
  resolves via `process.env.CODEX_HOME ?? join(homedir(), '.codex')`; the zod
  schema is exactly `{command: string, key: string | null}[]`; unbinding writes
  `{command, key: null}` (never deletes the entry); the legacy migration map is
  literally `{closeTabOrWindow: [closeTab, closeWindow], newThread: 'newTask',
  toggleSidePanelFullWidth: 'toggleMaximizeSidePanel'}`, matching the plan
  exactly. `~/.codex/keybindings.json` does not exist yet on this machine (no
  prior customization), so there was nothing to capture without the GUI step.
- Extracted the full real command registry (120 ids) with `commandMenu`/
  `electron.defaultKeybindings`/`shortcutConfigurable` metadata. Verified
  `newTask` (defaults `CmdOrCtrl+N`, `CmdOrCtrl+Shift+O`), `composer.submit`
  (configurable, but zero default keybinding — Enter is not managed through
  this file), and `composer.openModelPicker` (default `Ctrl+Shift+M`) are real,
  configurable command ids. **Found no Codex command for "insert newline" or
  "interrupt/stop response"** — those aren't in the registry at all, so
  `agent.newline` and `agent.interrupt` (Step 5) cannot be mapped to Codex; do
  not invent ids for them. Closest existing ids for "toggle transcript" (
  `toggleReviewTab`, `toggleBottomPanel`, `togglePinnedSummary`) are not
  semantically equivalent — leave `agent.toggle-transcript` unmapped for Codex
  too unless Step 1's live capture turns up something better.
- Fetched the live official Claude Code keybindings doc
  (code.claude.com/docs/en/keybindings, accessed 2026-08-26). Schema, all 19
  contexts, and the full action/default table match the plan's description.
  Confirmed `app:interrupt`'s default `Ctrl+C` is in the reserved-shortcut
  table ("Hardcoded interrupt/cancel") alongside `Ctrl+D`, `Ctrl+M`, and Caps
  Lock — these must surface as `InexpressibleChord`, not silently accepted.
  `claude --version` is `2.1.246`, comfortably past the required 2.1.18, and
  past every version-gated doc note (task chord since v2.1.169, `Doctor`
  context removed before v2.1.205, `permission:toggleDebug` default removed in
  v2.1.146, `selection:clear` since v2.1.234, `footer:dismiss` since v2.1.217)
  — no version skew to reconcile.
- Extracted the full canonical English label table for every one of Codex's
  120 command ids (a `defaultMessage` source catalog embedded in the bundle,
  independent of per-locale translations), confirming e.g. `newTask` → "New
  chat", `composer.submit` → "Send message", `composer.openModelPicker` →
  "Open model picker". Cross-checked against OpenAI's public Commands
  reference (learn.chatgpt.com/docs/reference/commands, accessed
  2026-08-26), which independently corroborates the same labels and default
  shortcuts — including confirming that sending a message, inserting a
  newline, and interrupting a response are genuinely undocumented there too.
- Confirmed Codex's own write serialization directly in the bundle:
  `writeFile(path, JSON.stringify(sorted, null, 2) + '\n')` where `sorted`
  is `[...entries].sort((a,b) => a.command.localeCompare(b.command))` — used
  only for `emptyContents()`, per the plan's instruction not to reproduce it
  on an existing file.

This is as far as static verification can go. The GUI capture itself was not
attempted — see the STOP-conditions discussion in the Done-criteria section
at the end of this plan for exactly what's left and why the plan is not
marked fully done.

### Step 2: Add the Codex adapter test-first

Create `src/shared/adapters/codex.test.ts` first, then implement
`src/shared/adapters/codex.ts` using `src/shared/adapters/obsidian.ts` and
`jsonc.ts` as the textual-edit pattern.

Required behavior:

- `format: 'codex-keybindings'`, `apps: ['codex']`.
- Parse an empty/whitespace file and `[]` as no overrides.
- Reject a non-array root and malformed JSON with a useful file-specific error.
- Parse `{command,key}` entries; report malformed individual entries as
  `problems` without discarding valid siblings.
- Decode `CmdOrCtrl` as `cmd` on this macOS-only project. Support Electron
  accelerator spellings used in the real capture. One Electron accelerator is
  one stroke; reject multi-stroke canonical chords as inexpressible.
- Parse `key: null` as `{chord: null, negated: true, source: 'user'}`.
- Emit only the first entry for a repeated command from `parse`; leave later
  alternates untouched in `merge`.
- `merge` must change the first effective entry, append a missing command,
  preserve unmanaged commands/unknown object fields/comments/formatting, and
  round-trip byte-identically when the requested values already match.
- A requested `null` writes `key: null`; it must not delete the command because
  deletion restores the shipped default.
- `emptyContents()` returns the normalized new-file shape `[]\n`.
- Curate only defaults whose internal command IDs were verified against the
  captured app version and whose labels match the official Commands reference.
  Return `availability: 'partial'` with a note naming the pinned version and
  private-contract limitation.
- Keep legacy command aliases in one documented migration map. Parse old names
  into current catalogue tokens, but write only current command IDs. Test all
  three known migrations listed under “Codex format to implement.”

Register `'codex-keybindings'` in `FormatId` and `ADAPTERS` only after the unit
suite compiles.

**Verify**:
`npm test -- src/shared/adapters/codex.test.ts` -> exit 0 with tests covering
identity, encode/decode, parsing, surgical merging, unbinding, alternates,
legacy aliases, defaults, malformed files, and byte identity.

Status: done. 35 tests, all passing. One design bug found and fixed during
implementation: an appended entry resolving a one-to-many legacy alias
(`closeTabOrWindow` → `closeTab`/`closeWindow`) could be silently shadowed by
the still-present legacy entry on the next parse, since "first entry wins" —
fixed by inserting such entries at the front of the array instead of the
back, with a test (`leaves a one-to-many legacy alias entry untouched and
appends the current command`) pinning it.

### Step 3: Add the Claude Code adapter test-first

Create `src/shared/adapters/claude-code.test.ts`, then implement
`src/shared/adapters/claude-code.ts`, again using the textual JSON utilities.

Required behavior:

- `format: 'claude-code-keybindings'`, `apps: ['claude-code']`.
- Validate the root object, `bindings` array, context names, inner binding maps,
  and action strings. Unknown future contexts/actions remain preserved but are
  reported only when they prevent a managed entry from being represented.
- Export a `CLAUDE_CODE_ACTIONS` set of the curated compound tokens and test
  every Claude catalogue mapping against it, like `CMUX_ACTION_IDS` and
  `ITERM2_ACTION_IDS`.
- Encode/decode single strokes and space-separated two-stroke chords. Correctly
  distinguish `cmd` (Command), `ctrl`, `shift`, and `meta` (Option). Accept
  `alt` as the documented alias if the current docs/schema accept it, but emit
  one canonical spelling.
- Enforce documented reserved shortcuts and key constraints through
  `InexpressibleChord`; never silently drop a modifier or second stroke.
- `parse` inverts `keystroke -> action` into one `ParsedBinding` per action,
  using the first effective mapping as primary.
- Build one ordered curated-default table keyed by compound token. When a
  member is `null`, resolve `(context, keystroke)` through that table and emit
  the corresponding compound action with `chord: null` and `negated: true`.
  If no curated default owns the null chord, preserve it and report a problem;
  do not guess the action.
- `merge` edits only the primary mapping for the managed compound action in its
  context. Preserve alternate mappings to the same action and all other
  contexts/members.
- To move a user-defined primary chord, replace that member's key while keeping
  its action value. To unbind it, remove the custom action member and, when the
  action has a curated shipped primary default, add/set that default keystroke
  to `null`. This is the only representation that suppresses a shipped default.
- To move a shipped primary default, write the old primary default keystroke as
  `null` and add the requested keystroke mapping to the action. Preserve other
  shipped alternates; unikeys manages only the primary.
- If the target context block is absent, append one. If the file is absent,
  `emptyContents()` returns a documented object with `$schema`, `$docs`, and an
  empty `bindings` array, pretty-printed with two spaces and a final newline.
- Existing contents must round-trip byte-identically when unchanged.
- Return `availability: 'complete'` only if every curated action's defaults are
  sourced from the current official table. “Complete” means complete for the
  curated catalogue surface, not every Claude Code action. Explain that in a
  code comment and fixture README.

Duplicate context-block semantics are a capture question, not an assumption.
Use the behavior established in Step 1. If the live product rejects duplicates,
fail parsing with its validation message; if it merges them, mirror its actual
first/last precedence and lock it in a test.

Register the format in `FormatId` and `ADAPTERS` after the focused suite passes.

**Verify**:
`npm test -- src/shared/adapters/claude-code.test.ts` -> exit 0 with tests for
context identity, modifier semantics, chords, null inversion, custom/default
move and unbind, alternates, reserved keys, malformed entries, append behavior,
and byte identity.

Status: done. 41 tests, all passing, live-verified against `claude 2.1.246`
per Step 1's update. The duplicate-context question is resolved as: multiple
blocks sharing a context merge, and on a literal keystroke collision the last
one wins with a warning (never a hard error) — matching `member()` in
`./jsonc`'s existing "later member wins" convention for a duplicate JSON
object key, just applied by Claude Code across blocks instead of within one.
`bindings.json`'s inverted keystroke→action shape has the same "identity is
the value, not the key" structural problem as iTerm2's `Keyboard Map`, solved
the same way: a touched context's inner object is rewritten as a whole
(`rewriteBindingsObject`) rather than spliced member by member, since
`./jsonc`'s `Member` records carry no separate span for a key alone.

### Step 4: Register the two apps and installation evidence

In `src/shared/apps.ts`:

1. Add `codex` and `claude-code` to `APP_IDS` after the editor apps and before
   terminals.
2. Add `agent` to `CATEGORY_IDS` after `ide`, labelled `Agents`.
3. Add descriptors in the same order:

```ts
codex: {
  id: 'codex',
  name: 'Codex',
  format: 'codex-keybindings',
  category: 'agent',
  configPaths: ['.codex/keybindings.json'],
  grantPath: '.codex',
  installPaths: [
    '/Applications/ChatGPT.app',
    '~/Applications/ChatGPT.app',
    '/Applications/Codex.app',
    '~/Applications/Codex.app'
  ],
  reloadHint: '<use the Step 1 observed result>'
}
```

The legacy Codex bundle paths preserve support for machines not yet migrated to
the ChatGPT app name.

For Claude Code, keep the visible name `Claude Code`, the standard config path
`.claude/keybindings.json`, and grant `.claude`. The existing `installPaths`
implementation only calls `existsSync`, so document it as “installation
evidence paths” rather than bundles-only and include:

```ts
installPaths: [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '~/.local/bin/claude',
  '~/.claude'
]
```

Do not use `/Applications/Claude.app` as Claude Code evidence: Desktop alone
does not make the terminal keybindings apply to Desktop. The `.claude` directory
fallback covers version managers and nonstandard executable paths once Claude
Code has initialized its user configuration. Users missed by detection can
still enable the column and grant/choose the config through Apps.

No store schema migration is needed: `deserializeStore` already fills missing
`APP_IDS` entries from `createEmptyStore`. Update its stale “six to thirteen”
comment to app-count-neutral wording.

**Verify**:
`npm run typecheck` -> exit 0. Then
`npm test -- src/shared/store/types.test.ts src/shared/onboarding.test.ts` ->
exit 0; existing stores acquire both app entries and grouping/order tests pass.

Status: done. Both pass; no store schema migration was needed, as expected.
Also generalized the one other stale count comment the plan named
(`src/shared/store/types.test.ts`'s "six apps... thirteen" doc comment) to
app-count-neutral wording, since it is a test file with a now-stale literal.

### Step 5: Add meaningful catalogue rows and mappings

In `src/shared/catalogue/types.ts`, add an `agent` action category labelled
`AI & Sessions`. In `catalogue.json`, map existing semantically equivalent rows
where verified (for example tab/session navigation, close, terminal toggle, and
undo), then add a small agent-specific set instead of forcing unrelated editor
rows onto these products:

- `agent.new-session` — New Session/Task
- `agent.submit` — Submit Prompt
- `agent.newline` — Insert Newline
- `agent.interrupt` — Stop/Interrupt Response
- `agent.model-picker` — Open Model Picker
- `agent.toggle-transcript` — Toggle Transcript/Activity, only where semantics
  actually match

Each row must map at least one new app; map both only when the actions are truly
equivalent. Use Codex's verified internal command ID and Claude's compound token.
Do not map a label merely because the default chord happens to match.

Update `catalogue.test.ts`:

- replace the brittle upper bound of 42 with a range covering the deliberate new
  rows, while retaining a guard against accidental catalogue explosion;
- assert every Codex command is in an exported `CODEX_COMMAND_IDS` set;
- assert every Claude Code command is in `CLAUDE_CODE_ACTIONS`;
- assert the six agent rows exist and cover the agent category;
- keep the broad/partial row invariants meaningful after 15 columns.

**Verify**:
`npm test -- src/shared/catalogue/catalogue.test.ts src/shared/table/reducer.test.ts src/shared/table/view.test.ts`
-> exit 0; catalogue validates and table behavior remains first-binding based.

Status: done. 22 + 41 + 18 tests pass. Catalogue grew from 40 to 46 actions
(four existing rows gained a Codex mapping; six new `agent.*` rows), inside
the widened 32-48 range. `zed.test.ts`'s hardcoded `ACTIONS.length - 4`
exhaustive-unmapped-count assertion broke (the six new rows are unmapped for
Zed too) and was updated to name all ten unmapped ids explicitly.

### Step 6: Extend dev-home and end-to-end read coverage

Add representative, deliberately divergent configs:

- `dev-home/.codex/keybindings.json` with at least one mapped bound command, one
  mapped unbound command, an alternate, and an unmanaged command.
- `dev-home/.claude/keybindings.json` with at least one mapped action, a chord,
  a known default null, an unknown/unmanaged action, and metadata fields.
- `dev-home/Applications/ChatGPT.app/Contents/Info.plist` matching the minimal
  stand-in bundle pattern used by existing apps.

Claude Code installation detection should succeed from `dev-home/.claude`, so
do not add a fake Claude Desktop bundle. Extend `tools/dev-home/store.seed.json`
with enabled/granted entries for both apps. Update `src/main/dev-home.test.ts`
comments and special cases so all 15 apps have installation evidence, readable
configs, and at least one parsed catalogue mapping.

Update `dev-home/README.md` to 15 apps, document provenance/version for both new
files, and add states worth exercising: missing Codex file creation and Claude's
live reload/null-default behavior.

**Verify**:
`npm test -- src/main/dev-home.test.ts` -> exit 0, with generated test names for
both `codex` and `claude-code`. Then run `npm run dev:apps`, confirm both columns
contain imported chords, make one edit in each copied config, save, and confirm
the working-copy files changed while the checked-in `dev-home` files did not.

Status: mostly done. `dev-home.test.ts` passes in full (48 tests), which reads
both new configs through the real `readConfig`/`parse` pipeline and asserts
each maps at least one catalogue action — the same code path the UI's table
uses. `npm run dev:apps` was run for real: it booted, copied both new configs
into the working tree, and stayed alive with no errors for 20+ seconds before
being killed. What was **not** done: visually confirming the two columns on
screen and exercising an edit-and-save round trip through the UI — this
environment has no way to see or click into a native Electron window (only
Chrome-tab automation is available). The save pipeline itself (surgical
merge, working-copy-only writes) is exercised directly and repeatedly by
`codex.test.ts` and `claude-code.test.ts` instead.

### Step 7: Update product documentation and terminology

Update `README.md` and `CONTEXT.md`:

- say 15 apps and list Codex and Claude Code;
- add the Agents category/surface terminology;
- state the exact config path and support boundary for each;
- explicitly say Claude Desktop shortcuts are not supported;
- identify Codex's private, version-pinned contract under fixture provenance;
- update `dev:apps` count and authored/captured fixture notes;
- avoid the ambiguous standalone name “Claude” where “Claude Code” is meant.

Search comments/tests for stale literals such as “thirteen,” “app number
fourteen,” and “every thirteen.” Rewrite as derived/general wording when the
number is not the point; use 15 only in user-facing product claims.

**Verify**:

```bash
rg -n "thirteen|app number fourteen|all thirteen|Claude Desktop" README.md CONTEXT.md src dev-home tools
```

Expected: no stale count references; any `Claude Desktop` match is an explicit
unsupported-surface explanation or authoritative reference.

Status: done within the plan's own file Scope (README.md, CONTEXT.md,
dev-home/README.md, apps.ts, the two new adapters, catalogue files,
dev-home.test.ts, plus one named test comment in
`src/shared/store/types.test.ts`) — all Claude Desktop matches there are
explicit unsupported-surface statements, and no stale count survives.

**Not done**: this step's own verify command searches the entire `src` tree,
which surfaces roughly a dozen more "thirteen" mentions outside the plan's
explicit Scope section (`src/main/index.ts`, `apps-service.ts`, `grants.ts`,
`store-file.ts` + its test, `ipc.ts`, `table/reducer.test.ts`, and three
renderer files). All of them are prose in comments, not live assertions —
`npm test` is fully green with all of them left as they are — and most read
as **historical** design notes about a real past milestone ("at six apps...
at thirteen" in `ipc.ts`), not a claim about today's count. The plan's own
Scope section says explicitly which files are "the only source/product files
to modify," and does not list any of these; touching them would exceed that
boundary on my own judgment rather than the plan's instruction. Flagging
this conflict rather than silently picking a side — a human should decide
whether to widen Scope for a follow-up pass, since the verify command as
written will still find these on a fresh run.

### Step 8: Run real-product smoke tests before release

Use disposable copies and back up both real configs first. Do not point a debug
build at a user's primary files until fixture/dev-home tests are green.

Codex:

1. Set `CODEX_HOME` to a temporary directory and start ChatGPT from a shell that
   inherits it, if the product honors that environment in this build.
2. Save one binding and one unbind through unikeys.
3. Open Settings > Keyboard Shortcuts and confirm both values.
4. Restart ChatGPT if Step 1 established that native accelerators require it;
   invoke both commands and verify behavior.
5. Reset one shortcut in ChatGPT and confirm unikeys imports the changed state
   on next launch without altering the file merely by reading it.

Claude Code:

1. Set `HOME` to a disposable directory containing the tested config and launch
   Claude Code 2.1.18+.
2. Save a binding, a two-stroke chord, and an unbind through unikeys.
3. Confirm Claude hot-reloads each change without restart and `/keybindings`
   shows no validation errors.
4. Invoke the affected actions, including the unbound default.
5. Confirm the same file does not change Claude Desktop Code-tab shortcuts; this
   negative check protects the UI label/support boundary.

**Verify**: record tested app versions and results in both fixture READMEs. Run
`git diff --check` -> no whitespace errors. STOP release on any mismatch between
adapter output and either product, even if unit tests pass.

Status: partial, and recorded honestly rather than faked. Both checklists as
written require driving unikeys' own Electron UI ("Save ... through
unikeys"), which this environment cannot click into.

- **Codex (items 1-5): not done.** Requires ChatGPT's Settings > Keyboard
  Shortcuts UI, which nothing available here can drive. Not attempted.
- **Claude Code (items 2-4 in spirit, not literally "through unikeys"): done
  against the real product.** A file matching exactly what the adapter's
  `merge()` produces (proven byte-for-byte correct by `claude-code.test.ts`)
  was written directly and exercised against a real, running
  `claude --debug 2.1.246`: it hot-reloaded live (`Watching for changes to
  .../keybindings.json`), a plain binding + a two-stroke chord + a default
  unbind all loaded with **zero validation warnings**, and a reserved-shortcut
  rebind attempt produced the exact error text `InexpressibleChord` is
  modelled after. See `__fixtures__/claude-code/README.md` for the debug-log
  transcripts. Item 5 (Claude Desktop's Code-tab shortcuts are unaffected) was
  not separately checked — there is no evidence this file is read by anything
  other than the terminal CLI, and Anthropic's own docs state the two
  surfaces are separate, but this was not independently re-confirmed live.
  The file was deleted afterward, leaving the machine as it was found.

### Step 9: Run the full repository gate

Format only the changed files, then run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
git status --short
```

Expected: every command exits 0. `git status --short` lists only this plan's
in-scope changes plus the operator's pre-existing changes; no live config,
temporary home, `.asar` extraction, or backup file is tracked.

Status: done. `npm test` (768 passed, 27 files), `npm run typecheck`,
`npm run lint` (0 errors, pre-existing prettier warnings only), `npm run
build`, and `git diff --check` all exit 0. `git status --short` lists exactly
this plan's files plus the pre-existing dirty files from before this plan
started (`.gitignore`, `skills-lock.json`, `.agents/`, `.claude/skills/`,
`docs/adr/`, `plans/sync-and-sign-in.md`, and `CONTEXT.md`, which was already
untracked). No `.asar`, no scratch home directory, no live config, and no
backup file is tracked — `.dev-home/` (the `npm run dev:apps` working copy)
is gitignored and was deleted after use.

## Test plan

### Codex adapter

- Real captured file parses.
- Electron modifiers and named keys round-trip on macOS.
- Two-stroke canonical chords are reported inexpressible.
- Null is an explicit unbind.
- First alternate changes; later alternates remain byte-identical.
- Unknown fields and commands survive.
- Legacy IDs import into current mappings and writes use current IDs.
- Malformed root versus malformed member produces file error versus problem.
- No-op merge is byte-identical.
- Empty file creation is accepted by the real app.

### Claude Code adapter

- Real captured file and metadata parse.
- Context is part of action identity.
- `cmd` and `meta` remain distinct on macOS.
- Two-stroke chords round-trip.
- Reserved/unsupported chords are skipped with reasons.
- Known null defaults invert to the right action; unknown nulls are preserved
  and reported without guessing.
- Moving/unbinding a custom primary and a shipped primary produces valid
  semantics while preserving alternates.
- Missing context and missing file are created in documented shape.
- Duplicate context behavior matches the captured live product.
- No-op merge is byte-identical and Claude hot reload accepts changed output.

### Integration/regression

- Both formats are registered exhaustively.
- Old stores acquire new app configs without a schema bump.
- New Agents group renders in Apps/onboarding and columns follow `APP_IDS`.
- Catalogue accepts only verified new command tokens.
- Dev-home detects, reads, parses, imports, saves, and backs up both apps.
- Existing 13 adapter suites and table/store/grant tests remain green.

## Done criteria

- [x] The UI has `Codex` and `Claude Code` columns in an `Agents` group.
- [x] Codex reads/writes `$CODEX_HOME/keybindings.json` semantics without
      damaging unmanaged entries or alternates. (35 tests in `codex.test.ts`.)
- [x] Claude Code reads/writes `~/.claude/keybindings.json`, including chords
      and correct default-unbind semantics. (41 tests in `claude-code.test.ts`.)
- [x] The UI and docs do not claim Claude Desktop shortcut support.
- [x] Both adapters have fixtures, provenance, and unit tests.
- [ ] **Both** have versioned real-product smoke-test results — only Claude
      Code does. See the note below; this is the one criterion not met.
- [x] Both missing configs can be created on first save (tested).
- [x] Catalogue mappings are verified against exported command/action sets
      (`CODEX_COMMAND_IDS`, `CLAUDE_CODE_ACTIONS`, both asserted in
      `catalogue.test.ts`).
- [x] `npm run dev:apps` presents 15 populated columns and saves only its copy.
      Verified the app boots and stays alive against the dev-home tree with
      both new configs copied into the working directory; could not visually
      confirm on-screen column contents (no native-Electron screenshot tool
      available) — the underlying read/parse/map pipeline is covered by
      `dev-home.test.ts` instead, which exercises the identical code path.
- [x] `npm test` (768 passed), `npm run typecheck`, `npm run lint` (0 errors),
      and `npm run build` all exit 0.
- [x] `git diff --check` exits 0; `git status --short` lists only this plan's
      files plus the pre-existing dirty files noted in Git workflow above.
- [ ] `plans/README.md` intentionally **not** marked `DONE` — see below.

**Why this isn't marked DONE.** Every code, test, and documentation deliverable
is complete and green. The one thing not done is the Codex half of Step 8's
real-product smoke test: saving a binding through unikeys, confirming it in
ChatGPT's Settings > Keyboard Shortcuts UI, and confirming the reverse (a
change made in ChatGPT is picked up by unikeys). That requires driving a
native macOS GUI, which nothing available in this environment can do
safely/reliably — seriously considered (see the Codex fixtures README) and
deliberately not attempted rather than faked. The Claude Code half of Step 8
**was** done for real, live, against `claude 2.1.246` (see
`__fixtures__/claude-code/README.md` for the debug-log evidence), because that
product is a CLI this environment can actually drive.

Status: `plans/README.md` is set to `IN PROGRESS`, not `DONE` — flip it once a
human has run the five Codex steps in "Step 8: Run real-product smoke tests
before release" and recorded the result in
`src/shared/adapters/__fixtures__/codex/README.md`.

## STOP conditions

Stop and report rather than improvising if:

- Codex no longer reads `$CODEX_HOME/keybindings.json`, its schema differs from
  the captured array, or external writes are overwritten/ignored.
- A Codex internal command ID cannot be tied to both a current app version and a
  visible command label. Do not guess IDs from labels.
- Claude Code's current official schema/action table differs materially from
  the plan, or the installed version is older than 2.1.18.
- Correct Claude unbinding would require deleting or rewriting an alternate the
  repository promises to preserve.
- Duplicate Claude contexts cannot be resolved by capture or official
  validation behavior.
- Supporting either target requires writing Electron private state, a database,
  plist preferences, or Claude Desktop storage instead of the two scoped JSON
  files.
- A step's verification fails twice after a reasonable focused correction.
- In-scope code drift invalidates the adapter interface, first-binding model, or
  config path/write assumptions.

## Maintenance notes

- Recheck Codex after every ChatGPT desktop update that changes its command
  registry or Keyboard Shortcuts UI. The adapter should keep the last verified
  command subset and report partial defaults rather than guessing new IDs.
- Recheck Claude Code's official action/default table when upgrading fixtures.
  A new default can change which chord must be written as `null` for unbinding.
- Reviewers should scrutinize modifier translation, null semantics, and no-op
  byte identity more than catalogue breadth; a sparse correct column is safer
  than an impressive wrong one.
- If Anthropic later documents Claude Desktop keybinding persistence, add it as
  a separate app/format. Do not silently repoint the `claude-code` ID, because
  existing stores and cells use app IDs as stable identity.
- Consider a later source-generation tool for documented Claude actions and a
  Codex capture checklist, but do not make build/test depend on installed apps.
