# 14 — Table readability

**What to build:** The table stays scannable now that it holds the full catalogue. Rows where every app agrees look different from rows where the apps have drifted, so the problems find you rather than the other way round. You can search or filter by action name to reach a specific binding without reading every row. Actions are grouped by category — editing, navigation, window management, terminal — rather than presented as one long undifferentiated list.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] Divergent rows are visually distinct from rows where all mapped apps agree
- [ ] Searching or filtering by action name narrows the table
- [ ] Actions are grouped by category
- [ ] Not-applicable cells are excluded from the divergence calculation, so a terminal-only action does not read as divergent
