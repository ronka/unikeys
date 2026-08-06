# 09 — Saving to WebStorm

**What to build:** Saving also writes your changes into WebStorm's real keymap, reusing the write pipeline from ticket 07. The work here is the JetBrains keymap merge: updating managed actions within the XML while preserving the rest of the document, and doing so correctly given that the keymap inherits from a parent — an override must be written as an override rather than as a redefinition of the whole keymap.

**Blocked by:** 04, 07.

**Status:** ready-for-agent

- [ ] Saving writes pending WebStorm changes into the real keymap
- [ ] Bindings and XML structure unikeys does not manage survive a save unchanged
- [ ] Overrides are expressed correctly against the inherited parent keymap
- [ ] WebStorm participates in the existing backup, atomic-write, and partial-failure reporting behaviour without special-casing
- [ ] Merge is covered by tests over fixture strings, including round-tripping unchanged content byte-identically
