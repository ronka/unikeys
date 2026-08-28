# A deployed web surface, because Sign in with Apple requires one

unikeys is a desktop app, and the request was to keep its data in Neon. It cannot talk to
Neon directly: a `web/` workspace in this repo, deployed to Vercel on a domain we own, sits
in front of the database and hosts the better-auth server. A future reader will reasonably
wonder why a macOS Electron app contains a Next.js project, so the three constraints that
force it are recorded here.

## The constraints

1. **Apple refuses non-HTTPS return URLs** for Sign in with Apple, and requires the return
   domain to be registered against a Services ID and verified. There is nowhere inside a
   desktop app for that URL to point.
2. **better-auth's `baseURL` validator rejects custom schemes.** Setting it to
   `com.ronkaa.unikeys://` — the arrangement Electron's own security guidance suggests —
   throws. The issue was raised upstream and closed *not planned*
   ([better-auth#7149](https://github.com/better-auth/better-auth/issues/7149)), so this is
   settled behaviour rather than a bug awaiting a fix.
3. **The App Store build cannot open a loopback listener.** `build/entitlements.mas.plist`
   grants `com.apple.security.network.client` but deliberately not `network.server`, and
   its comment says so in as many words. The standard Electron OAuth pattern — PKCE against
   an ephemeral `http://127.0.0.1:PORT` redirect — is therefore dead on that channel.

## Consequences

The callback is a custom URL scheme, `com.ronkaa.unikeys://`, which is the only shape that
works identically on both the DMG and App Store builds. None of it exists yet: there is no
`protocols:` key in `electron-builder.yml`, no `CFBundleURLTypes`, and no `open-url`
handler. On macOS `open-url` arrives on the already-running instance, so it must route
through the existing `showMainWindow()` rather than `createWindow`.

The domain cannot be a `*.vercel.app` subdomain — that is on the Public Suffix List and
Apple will not verify it.

`web/` lives in this repo rather than its own so that the cell shape and the canonical chord
format are the same file on both sides of the wire instead of a copy that drifts.
`electron-builder.yml` already excludes `docs/`, `plans/` and `tools/` from the asar, so
`web/` simply joins that list.

All backend HTTP stays in the main process behind `src/shared/ipc.ts`. The renderer's CSP is
`default-src 'self'` with no `connect-src`, and `entitlements.mas.inherit.plist` cannot widen
helper capabilities — macOS rejects combining `inherit` with additional entitlements.

Neither `npm run dev` nor the DMG build can surface a sandbox networking failure, so
validating any of this needs a real signed TestFlight build.
