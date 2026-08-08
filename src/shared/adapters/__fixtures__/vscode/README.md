# VSCode fixtures — provenance

One fixture here is a genuine capture. The rest were authored by hand from
knowledge of the `keybindings.json` format, and remain a reconstruction rather
than evidence.

## Captured

`captured-antigravity.json` is `~/Library/Application Support/Antigravity/User/keybindings.json`
copied byte for byte off a Mac running **Antigravity 1.16.5**. Nothing was
scrubbed because there was nothing personal in it: the file is the header
comment Antigravity writes into a fresh config plus a single entry, `cmd+i` →
`composerMode.agent`.

It is the most useful file in this directory despite its size, because it is
real:

- it proves a Code OSS fork keeps a standard `keybindings.json`, which is the
  whole reason Cursor, Kiro and Antigravity share the VSCode adapter;
- it carries a **fork-specific command** no VSCode build has, so the merge test
  over it is the only place the suite shows an unmanaged binding unikeys does
  not understand surviving a write byte for byte;
- it is indented with four spaces and ends **without a trailing newline**,
  neither of which any authored fixture here does — so it exercises layout
  detection against a shape nobody chose for the tests.

Kiro is installed on the same machine but has no `keybindings.json` yet, only a
`User/` directory. That is the `config-not-created` state rather than a missing
fixture: there is no file to capture, `writeTarget` supplies
`~/Library/Application Support/Kiro/User/keybindings.json` and the first save
creates it. Nothing was written to a real app's config to produce this
directory.

## Authored

**`basic.json`, `empty-array.json`, `malformed.json` and `tricky-strings.json`
were authored by hand and not captured from a real VSCode or Cursor
installation.** The machine this adapter was written on was Linux with neither
editor installed, so a genuine capture was not possible. Each was written to
match the real format as faithfully as possible — the header comment VSCode
writes into a fresh file, real command ids, real `when` clause syntax, line and
block comments, a trailing comma, and a `-command` negation entry — but they are
a reconstruction.

**Replace them with real captures when VSCode and Cursor are to hand**, by
copying `~/Library/Application Support/Code/User/keybindings.json` and the Cursor
equivalent (scrubbed of anything personal). Any behaviour the tests assert that a
real capture contradicts should be treated as the tests being wrong, not the
capture.

| File | Provenance | Purpose |
| --- | --- | --- |
| `captured-antigravity.json` | Captured, Antigravity 1.16.5 | A real fork config: four-space indent, no trailing newline, and the fork-only command `composerMode.agent`. |
| `basic.json` | Authored | A representative user config: header comment, line and block comments, `when` clauses, a two-keystroke chord, a negation entry, a trailing comma. |
| `empty-array.json` | Authored | A file VSCode created but the user never edited. |
| `malformed.json` | Authored | A missing comma between members — a whole-file failure. |
| `tricky-strings.json` | Authored | String literals containing `//`, `/* */` and `,`, which a comment-stripping parser would corrupt, plus an entry with a chord unikeys cannot represent and one with no `key` at all. |
