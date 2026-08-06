# 06 — Editing a cell

**What to build:** Click a cell and record a new chord by pressing the keys, or type it as text when the OS would intercept the combination. Clear a binding, cancel a mis-pressed edit, review everything you have changed so far, and discard the lot.

Nothing reaches disk in this ticket — that is deliberate. Edits accumulate as pending changes held separately from the saved store, so the pending-changes view can show exactly what would be written and discarding is clean. Writing is ticket 07.

Model the table's interaction state as a pure reducer over the store. This is the seam that ticket 10's linked-row propagation will be built on, so it needs to be testable without rendering anything.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Clicking a cell and pressing a key combination sets that cell's chord
- [ ] A chord can be entered as text as an alternative to pressing it
- [ ] A cell can be cleared, and an in-progress edit can be cancelled without committing
- [ ] Entering a chord the target app's format cannot express is reported rather than silently accepted
- [ ] A pending-changes view lists every edit made since the last save
- [ ] Pending changes can be discarded, returning the table to its saved state
- [ ] Table state transitions are implemented as a pure reducer and covered by tests with no rendering involved
