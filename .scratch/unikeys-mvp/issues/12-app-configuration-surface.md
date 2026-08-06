# 12 — App configuration surface

**What to build:** A settings surface where you manage which apps unikeys knows about. unikeys detects which of the four supported apps are installed on your Mac and finds each one's config at its standard location, so the common case needs no work from you. When detection fails you can point unikeys at a config file manually. You can turn an app off, which hides its column and guarantees unikeys never writes to it. When a config is missing or cannot be parsed, you see that clearly — so a parse failure is never mistaken for "this app has no bindings".

**Blocked by:** 02, 03, 04.

**Status:** ready-for-agent

- [ ] Installed apps are detected automatically at their standard macOS locations
- [ ] A config path can be set manually when auto-detection fails
- [ ] An app can be disabled, which removes its column and excludes it from all writes
- [ ] A missing config and an unparseable config are reported distinctly, and neither is confused with an app that has no bindings
- [ ] App configuration persists across restarts
