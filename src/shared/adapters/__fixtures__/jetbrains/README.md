# JetBrains keymap fixtures — provenance

**These files were authored by hand, from knowledge of the JetBrains keymap
format. They were not captured from a real WebStorm installation.** The machine
this adapter was written on runs Linux and has no JetBrains IDE on it.

They aim to be faithful — real action ids, a `parent` attribute, an XML
declaration, comments, a `<mouse-shortcut>`, an action with several
`<keyboard-shortcut>` children, a two-keystroke shortcut, an explicitly removed
action, and deliberately inconsistent indentation — but faithful-by-authorship
is not the same as genuine, and issue 04 asks for genuine captures.

`parent-macos.xml` and `grandparent-default.xml` stand in for keymaps that in
reality live inside `WebStorm.app/Contents/lib/`, and their contents are a small
invented subset, not a copy.

**Replace these with real captures when a Mac with WebStorm is available**, and
re-run the tests: any assumption baked into the parser that the real format
contradicts should surface there rather than in a user's keymap.

Capture procedure, for whoever gets to a Mac first:

1. In WebStorm, duplicate the active keymap (Settings → Keymap → gear → Duplicate),
   change a few bindings, remove one, and add a two-keystroke shortcut.
2. Copy the resulting file from
   `~/Library/Application Support/JetBrains/WebStorm*/keymaps/*.xml`.
3. For the ancestors, extract the keymap XML from
   `/Applications/WebStorm.app/Contents/lib/` (they are inside the jars).
