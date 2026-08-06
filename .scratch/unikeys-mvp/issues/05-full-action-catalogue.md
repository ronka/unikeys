# 05 — Full action catalogue

**What to build:** The table stops showing a seeded handful of actions and shows the real catalogue — roughly 30 hand-authored actions covering editing, navigation, window and pane management, and terminal operations, each mapped to the corresponding command in every app that has one.

The catalogue is shipped data, not code, and is validated when the app starts so a malformed or unknown-command entry fails loudly rather than producing a silently broken row. Design the catalogue's shape so user-defined actions can be added later without a schema migration — that capability is out of scope for the MVP but is the deferral most likely to be revisited.

This is blocked by all four adapters because the per-app command mappings cannot be authored credibly until each app's command vocabulary has been seen.

**Blocked by:** 02, 03, 04.

**Status:** ready-for-agent

- [ ] Around 30 actions are catalogued, each with a stable unikeys id, display name, and category
- [ ] Each action maps to at most one command per app; absence of a mapping is explicit and meaningful
- [ ] The catalogue validates at startup and reports malformed entries loudly
- [ ] Unmapped cells render as not-applicable rather than unbound
- [ ] The catalogue format can accommodate user-authored actions later without changing its schema
