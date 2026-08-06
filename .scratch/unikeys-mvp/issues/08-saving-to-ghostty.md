# 08 — Saving to Ghostty

**What to build:** Saving also writes your changes into Ghostty's real configuration file, reusing the write pipeline established in ticket 07 — backups, atomic writes, and transactional per-app reporting all come for free. The work here is Ghostty's surgical merge: updating the `keybind =` lines for managed actions while leaving every other line in the config exactly as it was.

**Blocked by:** 03, 07.

**Status:** ready-for-agent

- [ ] Saving writes pending Ghostty changes into the real config
- [ ] Every line unikeys does not manage survives a save unchanged, including comments and ordering
- [ ] Ghostty participates in the existing backup, atomic-write, and partial-failure reporting behaviour without special-casing
- [ ] Merge is covered by tests over fixture strings, including round-tripping unchanged content byte-identically
