# 07 — Saving to VSCode and Cursor

**What to build:** Hit save and your real VSCode and Cursor configuration files change to match the table. This is the first ticket that writes to disk, and it carries the entire write pipeline that tickets 08 and 09 will reuse.

Writes are surgical: only entries for actions unikeys manages are touched, and everything else in the file — other bindings, ordering, comments, formatting — survives untouched, so hand-editing the apps for anything unikeys doesn't cover stays safe. Before the first write to a file in a session, unikeys copies it to a timestamped backup and tells you where backups live. Files are written atomically so an interrupted write cannot truncate a real config. unikeys computes the full new contents for every affected file before writing any of them, and a failure partway is reported per app with a precise account of what was and was not written.

Watch VSCode's `-command` negation entries — removing a default binding is expressed as a negation entry, not an absence, and a merge that mishandles this will silently corrupt the user's setup.

**Blocked by:** 02, 06.

**Status:** ready-for-agent

- [ ] Saving writes pending changes into the real VSCode and Cursor configs
- [ ] Bindings unikeys does not manage survive a save byte-for-byte, including comments and ordering
- [ ] A timestamped backup is taken before the first write to each file in a session, and its location is surfaced in the UI
- [ ] Writes are atomic — an interrupted write cannot leave a truncated config
- [ ] All new file contents are computed before any file is written
- [ ] A partial failure reports exactly which apps were written and which were not
- [ ] After a successful save the user is told the app must be restarted or its config reloaded
- [ ] Surgical merge is covered by tests over fixture strings, including round-tripping unchanged content byte-identically and handling `-command` negation entries
