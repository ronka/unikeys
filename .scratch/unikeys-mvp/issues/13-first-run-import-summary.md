# 13 — First-run import summary

**What to build:** The first time you open unikeys, after it has imported your bindings from every configured app, you see a summary: how many actions were found, how many apps were read, and how many rows currently disagree across your apps. It tells you the tool worked and points you at where to start.

The import itself must be non-destructive — simply opening unikeys never changes any app's configuration.

**Blocked by:** 11, 12.

**Status:** ready-for-agent

- [ ] After the first import, a summary shows actions found, apps read, and count of divergent rows
- [ ] Apps that could not be read are named in the summary rather than silently omitted
- [ ] The first run writes nothing to any app's configuration
- [ ] The summary appears only on first run, and can be dismissed
