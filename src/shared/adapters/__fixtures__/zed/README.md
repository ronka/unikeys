# Zed keymap fixtures — authored, not captured

**These files were written by hand from the documented `keymap.json` format. They
were not captured from a real Zed installation**, because Zed is not installed on
the machine this adapter was written on, so no genuine keymap was available to
copy.

They aim to be faithful — the header comment Zed writes into a fresh keymap, real
action names, real context expressions with `&&` and `||`, line and block
comments, a commented-out binding, a two-keystroke sequence, `cmd--` with a
hyphen as its base key, `null` unbinds, and an action carrying arguments — but
faithful-by-authorship is not the same as genuine.

The **shipped-defaults table** in `../../zed.ts` is authored the same way and for
the same reason: Zed keeps its default keymap inside the application bundle
(`assets/keymaps/default-macos.json`), where this adapter cannot read it. Actions
whose default chord could not be sourced carry none at all, which is why
`defaults('zed')` reports `partial`. The same rule governs
the shipped catalogue's `zed` commands: an action Zed has no confirmed command
for is omitted rather than guessed at.

**Replace all of this with real captures when a Mac with Zed is available**, and
re-run the tests: anything that breaks is a real assumption this adapter got
wrong, and any behaviour the tests assert that a genuine capture contradicts
should be treated as the tests being wrong, not the capture.

**The first thing to check on a real Zed** is the assumption the whole merge
design rests on: that a later block wins over an earlier one, so the block
unikeys appends at the end takes effect even where the user's own block binds the
same chord. unikeys' block deliberately carries no `context`, which is Zed's
spelling for "everywhere"; if Zed in fact ranks a matching binding by how
specific its context is, a global block would lose to the user's `Editor` one and
`merge` would need to name a real context instead.

Capture procedure, for whoever gets to a Mac with Zed first:

1. Rebind a few actions in Zed, unbind one, and add a two-keystroke sequence, then
   copy `~/.config/zed/keymap.json` (scrubbed of anything personal).
2. Run `zed: open default keymap` from the command palette and use it to check
   `DEFAULT_KEYS` and the catalogue's `zed` action names line by line. The four
   action names authored with least confidence are
   `workspace::ActivatePaneLeft`/`Right`/`Up`/`Down` and `pane::DeploySearch`.
3. Bind one action in your own block and the same action through unikeys, and
   confirm which chord actually fires.

| File                 | What it covers                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `populated.json`     | Three context blocks, a two-keystroke sequence, and `cmd--`: the ordinary case, inverted map and all |
| `commented.json`     | Line and block comments, a commented-out binding, an action with arguments, and a chord unikeys cannot read |
| `unbound.json`       | `null` unbinding a chord bound earlier in the file, one of Zed's own defaults, and one nothing claims |
| `empty-array.json`   | A keymap Zed created but the user never edited                                                  |
| `malformed.json`     | A missing comma between members — a whole-file failure                                          |
| `unikeys-block.json` | `populated.json` after one merge: the block unikeys owns, which a second merge must rewrite rather than duplicate |
