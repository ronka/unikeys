# 04 — WebStorm column

**What to build:** A fourth column appears, populated from your real WebStorm keymap. JetBrains stores keymaps as XML with parent-keymap inheritance, so resolving what a binding actually is means following the inheritance chain rather than reading a single flat file. This is the heaviest parser in the project.

Nobody has inspected a real JetBrains keymap while writing this spec; capture genuine keymap content as a test fixture before implementing against assumptions.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] The table shows a WebStorm column populated from the real keymap
- [ ] Parent-keymap inheritance is resolved, so an inherited binding appears rather than showing as unbound
- [ ] JetBrains chord notation, including two-keystroke sequences, converts to and from the canonical form in both directions
- [ ] The adapter conforms to the same string-based interface as the other adapters
- [ ] Parse and inheritance resolution are covered by tests using fixture content captured from a real keymap
