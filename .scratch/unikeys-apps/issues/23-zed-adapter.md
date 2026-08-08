# 23 — Zed column

**What to build:** Replace the `zed-keymap` stub with a real adapter. Zed's keymap is
`~/.config/zed/keymap.json`: a JSON array of context blocks, each holding a `bindings`
map. Two properties of that format drive the design, and both are new to this project.

**Blocked by:** 20.

**Status:** done — branch `feat/apps-zed`, commit `21bd84f`

**Files you own:** `src/shared/adapters/zed.ts`, `src/shared/adapters/zed.test.ts`,
`src/shared/adapters/__fixtures__/zed/`, `src/shared/catalogue/catalogue-zed.json`.
Nothing else — in particular, do **not** edit `catalogue.json`; ticket 26 folds your
fragment in.

## The format

```json
[
  {
    "context": "Editor",
    "bindings": {
      "cmd-s": "workspace::Save",
      "cmd-k cmd-s": "workspace::SaveAs",
      "cmd-p": null
    }
  }
]
```

- Chords are lowercase, hyphen-joined: `cmd`, `ctrl`, `alt`, `shift`, then the key.
  Two-keystroke sequences are space-separated inside one string, which lines up with
  `MAX_STROKES`.
- Blocks are scoped by `context` — a tree (`Workspace` → `Pane` → `Editor`) with `&&`
  and `||` expressions. Later blocks win over earlier ones.
- `null` as a value unbinds.

## The inversion

Every other format in this project is command → chord. Zed's is **chord → command**.
`parse` therefore has to invert: walk every block, and for each `chord: command` pair
emit a `ParsedBinding { command, chord }`. Where one command appears in several
contexts, first-wins matches what `indexBindings` in `apps-service.ts` does with the
result anyway. A `null` value is a `negated` binding, not an absent one — the same
distinction VSCode's `-command` entries carry.

## The merge

Do not edit the user's context blocks. Because later blocks win, `merge` should own a
single block appended at the end of the array — the same shape as the iTerm2 dynamic
profile, where unikeys owns one region outright rather than reaching into the user's.

Identify that block with a **marker comment**, not an invented `context` value — a Zed
context is semantic and matched against the focused element, so a made-up one would
never match and the bindings would never fire. Omit `context` entirely (global) or use a
real one, and let the comment be what a second merge looks for so it rewrites the same
block instead of appending another.

The round-trip guarantee still applies: merging unchanged content must produce a
byte-identical file, and the user's own blocks, comments and formatting must survive.
`src/shared/adapters/jsonc.ts` already does textual JSONC splicing for the VSCode and
cmux adapters — read it before writing anything new. Zed's keymap permits comments, so
a strict `JSON.parse`/`stringify` round-trip is not acceptable.

Decide and document what happens when the user has bound a managed command inside
their own block: unikeys' trailing block wins at runtime, so the cell is honest, but
the user's stale binding stays in the file. Saying so in a comment is enough; do not
start editing their blocks.

## Defaults

Zed ships its default keymap inside the application bundle
(`assets/keymaps/default-macos.json`), so it is not readable as a config file. Ship a
curated subset and report `availability: 'partial'` with a note, exactly as the VSCode
and JetBrains adapters do. Do not guess at bindings you cannot source — an empty cell
beats a wrong one.

## Catalogue fragment

`src/shared/catalogue/catalogue-zed.json`, a flat map of unikeys action id → Zed
command, covering as many of the 38 catalogue actions as Zed genuinely has an
equivalent for:

```json
{ "edit.save": "workspace::Save", "nav.go-to-file": "file_finder::Toggle" }
```

Omit an action rather than inventing a command for it. An absent key renders the cell
as not-applicable, which is correct and is better than a binding that will never fire.

## Fixtures

Zed is not installed on this machine, so fixtures are authored from the documented
format. Write `__fixtures__/zed/README.md` saying so, matching the wording of the
existing fixture READMEs. Cover at minimum: a populated multi-context keymap, a keymap
with comments, one with a `null` unbind, an empty array, and a malformed file.

## Definition of done

- [ ] The table shows a Zed column populated from `~/.config/zed/keymap.json` — renderer work, lands with ticket 27; Zed is not installed here so this stays unobserved
- [x] Zed's hyphen notation converts to and from the canonical chord in both directions, including two-keystroke sequences
- [x] `parse` inverts chord→command correctly across multiple context blocks, and treats `null` as an explicit unbind
- [x] `merge` writes one owned trailing block, rewrites that same block on a second merge, and leaves the user's blocks and comments untouched
- [x] Merging unchanged content round-trips byte-identically
- [x] `defaults('zed')` reports `partial` with a note, and ships only bindings that were actually sourced
- [x] `catalogue-zed.json` exists and maps only actions Zed really has
- [x] `npm test`, `npm run typecheck` and `npm run lint` pass
