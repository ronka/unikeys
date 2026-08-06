# 01 — VSCode bindings visible in the table

**What to build:** Launch unikeys and see your real VSCode keybindings in a table. unikeys finds your VSCode configuration on macOS, parses the bindings you have customised, and displays them as rows — one row per action, one column for VSCode — with chords rendered using macOS symbols (⌘ ⌥ ⇧ ⌃) rather than raw notation. Read-only: nothing is edited and nothing is written.

This is the tracer bullet. It cuts a complete path through every layer and therefore establishes the foundations the rest of the map builds on: the test runner, the canonical chord model, the adapter interface, the main↔renderer IPC surface, and the table shell. Seed the action catalogue with a handful of obviously-correct actions (around five) — the full catalogue is ticket 05.

Keep the adapter defined over strings, not files: parsing takes file contents and returns bindings, with a thin separate layer responsible for locating and reading the file. This is what makes the format work testable without touching a filesystem.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Running the app shows a table of seeded actions with a VSCode column populated from the real config
- [ ] Chords display as macOS symbols, not raw text notation
- [ ] An action with no VSCode binding renders as visibly empty rather than blank-ambiguous
- [ ] A canonical chord representation exists, covering modifiers, base key, and two-keystroke sequences
- [ ] VSCode notation converts to and from the canonical form in both directions
- [ ] The adapter parses file contents passed as a string and has no filesystem dependency
- [ ] The renderer performs no filesystem access; all config access is in the main process behind typed IPC
- [ ] Vitest is installed and `npm test` runs
- [ ] Adapter parse and chord translation are covered by tests using committed fixture strings
- [ ] A missing or unreadable VSCode config produces a clear message, not a crash or an empty table
