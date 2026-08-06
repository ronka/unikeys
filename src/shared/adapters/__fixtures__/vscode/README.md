# VSCode fixtures — provenance

**These fixtures were authored by hand from knowledge of the `keybindings.json`
format. They were not captured from a real VSCode or Cursor installation.**

The machine this adapter was written on is Linux with neither editor installed,
so a genuine capture was not possible. Every fixture was written to match the
real format as faithfully as possible — the header comment VSCode writes into a
fresh file, real command ids, real `when` clause syntax, line and block
comments, a trailing comma, and a `-command` negation entry — but they are a
reconstruction, not evidence.

**Replace them with real captures when a Mac with VSCode and Cursor is
available**, by copying `~/Library/Application Support/Code/User/keybindings.json`
and the Cursor equivalent (scrubbed of anything personal). Any behaviour the
tests assert that a real capture contradicts should be treated as the tests
being wrong, not the capture.

| File | Purpose |
| --- | --- |
| `basic.json` | A representative user config: header comment, line and block comments, `when` clauses, a two-keystroke chord, a negation entry, a trailing comma. |
| `empty-array.json` | A file VSCode created but the user never edited. |
| `malformed.json` | A missing comma between members — a whole-file failure. |
| `tricky-strings.json` | String literals containing `//`, `/* */` and `,`, which a comment-stripping parser would corrupt, plus an entry with a chord unikeys cannot represent and one with no `key` at all. |
