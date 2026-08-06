# 10 — Linked rows

**What to build:** Click "link" on a row and that action becomes the same chord across every app that supports it. From then on, editing any cell in the row changes all of them — this is the feature the app is named for, and what makes unikeys a sync tool rather than a bulk-edit button.

Linking a row whose apps currently disagree asks you which of the existing chords wins, rather than silently picking one and discarding the binding you actually wanted. Unlinking leaves every app holding the last shared chord rather than reverting to what it was before, so unlinking never undoes work you meant to keep. Apps the catalogue does not map for that action are skipped, so a linked editor action never tries to bind itself in the terminal. Linked state is saved and survives a restart.

Propagation belongs in the pure reducer from ticket 06 and nowhere else.

**Blocked by:** 06.

**Status:** ready-for-agent

- [ ] Linking a row makes every mapped app share one chord
- [ ] Linking a divergent row prompts for which existing chord wins
- [ ] Editing any cell in a linked row updates every mapped app, and no unmapped app
- [ ] Linked and unlinked rows are visually distinguishable at a glance
- [ ] Unlinking leaves each app holding the last shared chord
- [ ] Linked state survives a restart
- [ ] Propagation is implemented in the reducer and covered by tests, including a store serialise/deserialise round trip
