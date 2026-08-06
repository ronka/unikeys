# 03 — Ghostty column

**What to build:** A third column appears, populated from your real Ghostty configuration. Ghostty stores bindings as `keybind =` lines in a plain config file with its own chord notation — the first genuinely different format in the project, and therefore the real test of whether the adapter interface holds without leaking format concerns into the store or the UI.

Note that nobody has inspected a real Ghostty config while writing this spec; capture genuine config content as a test fixture before implementing against assumptions.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] The table shows a Ghostty column populated from the real config
- [ ] Ghostty chord notation converts to and from the canonical chord form in both directions
- [ ] The adapter conforms to the same string-based interface as the VSCode adapter with no changes to that interface
- [ ] Actions the catalogue does not map to a Ghostty command render as not-applicable, distinct from unbound
- [ ] Parse behaviour is covered by tests using fixture content captured from a real Ghostty config
