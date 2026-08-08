# Obsidian fixtures — provenance

**These fixtures were authored by hand from the documented `hotkeys.json` format.
They were not captured from a real Obsidian vault.**

Obsidian is not installed on the machine this adapter was written on, so a genuine
capture was not possible. Every fixture was written to match the real format as
faithfully as possible — an object of command id to an array of
`{ modifiers, key }` objects, `Mod` for the Command key, DOM
`KeyboardEvent.key` spellings (`"ArrowDown"`, `"PageDown"`, `" "` for space), and
an empty array for a command the user has explicitly unbound — but they are a
reconstruction, not evidence.

The **command ids** used here and in the shipped catalogue's `obsidian` commands
come from the same place: Obsidian's documented command names, not a list read out
of a running app. `switcher:open`, `command-palette:open`, `workspace:split-vertical`
and the rest are ids a real vault should confirm before unikeys is trusted to write
them; a mistyped id produces a cell that silently never fires.

**Replace these with real captures when a Mac with Obsidian is available**, by copying
`<vault>/.obsidian/hotkeys.json` from a vault with a few hotkeys set. Note that
Obsidian pretty-prints that file, so a real capture will look like `expanded.json`
rather than like the compact form the documentation shows. Any behaviour the tests
assert that a real capture contradicts should be treated as the tests being wrong,
not the capture.

| File                | What it covers                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `populated.json`    | A representative override file in the compact documented form, ending in an empty-array unbind.      |
| `expanded.json`     | The same format as Obsidian itself writes it: every array and object broken across lines.            |
| `alternates.json`   | Three bindings for one command. unikeys manages the first and must leave the other two alone.        |
| `modifier-mix.json` | `Mod`, `Ctrl`, the two together, `Meta`, all four at once, the space key and an unmodified F-key.    |
| `empty.json`        | `{}` — a hotkeys file with nothing overridden, and what `emptyContents()` creates.                   |
| `malformed.json`    | A missing comma between members — a whole-file failure, not a per-entry problem.                     |
| `tricky.json`       | One entry of every shape that is wrong on its own: a value that is not an array, a binding with no key, an unknown modifier, an unknown key, an item that is not an object, and a repeated command id where the later one wins. |
