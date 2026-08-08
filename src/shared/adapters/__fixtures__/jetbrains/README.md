# JetBrains keymap fixtures — provenance

These fixtures cover all three JetBrains IDEs unikeys supports — WebStorm,
IntelliJ IDEA and PyCharm — because there is only one format to cover. The
keymap is an IntelliJ platform file, not a per-IDE one: same XML, same
inheritance chain, same `Mac OS X 10.5+` parent, same action ids. Three copies of
`user-keymap.xml` under three IDE names would assert a difference that does not
exist, so the files below are deliberately shared rather than duplicated.

**These files were authored by hand, from knowledge of the JetBrains keymap
format. They were not captured from a real installation of any of the three
IDEs.** The machine this adapter was written on runs Linux and has no JetBrains
IDE on it. Widening the adapter to IntelliJ IDEA and PyCharm changed nothing
about that: no fixture was captured, so the caveat stands unchanged.

They aim to be faithful — real action ids, a `parent` attribute, an XML
declaration, comments, a `<mouse-shortcut>`, an action with several
`<keyboard-shortcut>` children, a two-keystroke shortcut, an explicitly removed
action, and deliberately inconsistent indentation — but faithful-by-authorship
is not the same as genuine, and issue 04 asks for genuine captures.

`parent-macos.xml` and `grandparent-default.xml` stand in for keymaps that in
reality live inside the application bundle (`WebStorm.app/Contents/lib/` and its
equivalents), and their contents are a small invented subset, not a copy.

**Replace these with real captures when a Mac with a JetBrains IDE is
available**, and re-run the tests: any assumption baked into the parser that the
real format contradicts should surface there rather than in a user's keymap. One
capture is enough for all three columns; if a second IDE ever turns out to
disagree, that disagreement is the thing worth a fixture of its own.

Capture procedure, for whoever gets to a Mac first:

1. In the IDE, duplicate the active keymap (Settings → Keymap → gear →
   Duplicate), change a few bindings, remove one, and add a two-keystroke
   shortcut.
2. Copy the resulting file from the IDE's versioned support directory —
   `~/Library/Application Support/JetBrains/WebStorm*/keymaps/*.xml`,
   `.../IntelliJIdea*` or `.../IdeaIC*`, `.../PyCharm*` or `.../PyCharmCE*`.
3. For the ancestors, extract the keymap XML from the bundle's
   `Contents/lib/` (they are inside the jars).
