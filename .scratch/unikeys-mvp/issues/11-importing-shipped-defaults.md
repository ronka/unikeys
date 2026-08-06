# 11 — Importing shipped defaults

**What to build:** Cells populate from each app's built-in default keybindings, not only from bindings you have explicitly customised. Without this most of the table starts blank, because most bindings are defaults — and a table that can't show you where your apps actually disagree is not worth opening.

**This is the riskiest ticket in the map, and it may not be one ticket.** Each app presents an unrelated sourcing problem: VSCode's defaults are compiled into the application rather than stored as a readable file; JetBrains ships keymaps inside the application bundle with parent inheritance to resolve; Ghostty documents its defaults but they may need transcribing. Investigate all three before committing to an approach, and split this ticket per app if the answers diverge — which is likely.

If defaults prove genuinely unobtainable for an app, that app still ships: its unoverridden cells start empty, and the limitation is surfaced to the user rather than hidden. Do not block the MVP on solving all three.

**Blocked by:** 02, 03, 04.

**Status:** ready-for-agent

- [ ] Cells show an app's default chord where the user has no override
- [ ] A user override takes precedence over the default for the same action
- [ ] The user can tell which chords came from defaults and which are their own customisations
- [ ] Any app whose defaults could not be sourced is handled gracefully, with the limitation surfaced rather than silent
- [ ] Default resolution is covered by tests at the adapter seam
- [ ] If the per-app approaches diverge, this ticket is split and the split is recorded before implementation continues
