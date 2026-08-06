# 02 — Cursor column

**What to build:** A second column appears in the table, populated from your real Cursor configuration. Cursor is a VSCode fork sharing the `keybindings.json` format, so this reuses the existing adapter with a different configuration path — the point of the ticket is proving the adapter seam supports more than one app and that the table renders multiple columns side by side.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] The table shows VSCode and Cursor as separate columns, each populated from its own config
- [ ] The VSCode adapter is reused rather than duplicated; only path resolution differs
- [ ] An app being absent or unparseable affects only its own column; the other still renders
- [ ] Nothing about a specific app is hardcoded into the table rendering
