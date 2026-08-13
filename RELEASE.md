# Releasing unikeys for macOS

unikeys ships through two channels, from one codebase:

- a **signed, notarized universal DMG** you host yourself — `npm run release:mac`
- the **Mac App Store**, via TestFlight — `npm run submit:testflight`

The App Store requires App Sandbox, which is why the second one took work: a sandboxed
app cannot open `~/Library/Application Support/Code/User/keybindings.json` or a JetBrains
keymap directory on its own say-so. It reaches them through folders the user hands over
in a macOS open panel, which `src/main/grants.ts` turns into security-scoped bookmarks
that survive a quit. The DMG build has no sandbox and takes none of those paths.

Bundle identifier: `com.ronkaa.unikeys`. Team ID: `9F9UG2CY8U`.

## One-time setup

### 1. Developer ID Application certificate

You need a **Developer ID Application** certificate — not "Developer ID Installer"
(that signs `.pkg` files) and not "Apple Distribution" (that is App Store only).
Creating one requires the Account Holder role on the Apple Developer account.

Via Xcode: **Xcode → Settings → Accounts →** select your Apple ID **→ Manage
Certificates → + → Developer ID Application**.

This cannot be automated. `POST /v1/certificates` on the App Store Connect API returns
`403 FORBIDDEN_ERROR — This operation can only be performed by the Account Holder`, and
API keys cannot hold the Account Holder role, so Developer ID certificates are only ever
issuable through Xcode or the web portal while signed in as the Account Holder.

Back up the private key once the certificate exists — Keychain Access → My Certificates →
right-click the identity → Export → `.p12`. Losing it means you cannot sign updates under
the same identity and must issue a new certificate (they are capped at 5 per account).

Verify it landed in the keychain:

```bash
security find-identity -v -p codesigning
```

You should see one line containing `Developer ID Application: <Your Name> (TEAMID)`.
The parenthesised value is your Team ID.

### 2. Notarization credentials

electron-builder's `notarize: true` reads credentials from **environment variables**
only — it does not use a `notarytool` keychain profile. Use either:

**App Store Connect API key (recommended):** create a key at
App Store Connect → Users and Access → Integrations → App Store Connect API, download
the `.p8`, and set `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`.

**Apple ID + app-specific password:** create an app-specific password at
appleid.apple.com → Sign-In and Security → App-Specific Passwords, then set
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Keep the `.p8` out of the repo — export the variables in your shell or a local untracked
file.

## Building a release

```bash
export APPLE_API_KEY="$HOME/Downloads/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=<issuer uuid from App Store Connect → Integrations>

npm run release:mac
```

`release:mac` is `build:mac` followed by `notarize:dmg`. Both steps are needed:

- `build:mac` signs and notarizes the **app** and staples a ticket to it, then wraps it
  in a DMG (signed, because `dmg.sign: true`).
- `notarize:dmg` notarizes and staples the **DMG itself**. electron-builder does not do
  this, and the DMG is the file people download. Skip it and Gatekeeper rejects the
  image with `no usable signature` even though the app inside is perfectly notarized.

> **Not yet exercised end to end.** The 1.0.0 DMG was signed by hand with `codesign`
> after the fact; `dmg.sign: true` and `release:mac` were added afterwards and have
> never run. electron-builder has historically disabled DMG signing by default because
> it was unreliable, so on the first real `release:mac` confirm the DMG is signed before
> trusting it — `codesign -dv dist/unikeys-<version>.dmg` should print a `TeamIdentifier`.
> If it prints nothing, the DMG went out unsigned and `notarize:dmg` will have stapled a
> ticket onto an unsigned image, which Gatekeeper still rejects.

Check credentials without burning a full build first — this fails fast on a bad key:

```bash
xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
```

Signing identity is auto-discovered from the keychain; notarization runs automatically
and staples the ticket. Output is `dist/unikeys-<version>.dmg`, universal (x86_64 +
arm64). Expect several minutes — the universal build packages both architectures and
notarization is a network round-trip.

## Submitting to TestFlight and the App Store

```bash
npm run submit:testflight
```

Builds the sandboxed universal `.pkg`, validates it against App Store Connect, uploads
it, and prints what to expect next. `npm run check:testflight` does everything except
the upload — use it whenever you have changed the build configuration, because an
uploaded build cannot be deleted, only expired, and a bad one sits in TestFlight beside
the good one.

### One-time setup

1. **Apple Distribution** certificate (signs the app) and **3rd Party Mac Developer
   Installer** (signs the `.pkg`). Both via Xcode → Settings → Accounts → Manage
   Certificates. `security find-identity -v` should list both.
2. A **Mac App Store** provisioning profile for `com.ronkaa.unikeys`, saved as
   `build/embedded.provisionprofile`. Not in the repo — it carries the team's
   identifiers.
3. An app-specific password from appleid.apple.com → Sign-In and Security, stored in the
   keychain under the Apple ID it belongs to:

   ```bash
   security add-generic-password -s AC_PASSWORD -a you@example.com -w
   ```

   The script reads both the password and the Apple ID from that one entry, so nothing
   about your account lives in this repository. `APPLE_ID` and
   `APPLE_APP_SPECIFIC_PASSWORD` override it if you prefer environment variables.

### Build numbers

App Store Connect refuses an upload whose `CFBundleVersion` is not above the last one,
so the script passes `--config.buildVersion=$(git rev-list --count HEAD)` and checks the
built `Info.plist` actually carries it. That means **a TestFlight build needs no version
bump** — `package.json`'s version is the marketing version and changes when you want it
to, not because Apple counted.

The commit count only rises while history does. After a squash or a rebase it can come
back lower, and a lower build number is a rejection whose message does not say so. Then:

```bash
BUILD_NUMBER=<something higher> npm run submit:testflight
```

The switch to plain integers is one-way. Builds 1.0.0 and 1.1.0–1.1.1 were submitted
carrying the marketing version as `CFBundleVersion`, and 61 sorts above all of them — but
a `.pkg` from bare `npm run build:mas` carries the marketing version again, which is now
_lower_ than everything submitted, and is rejected with the same message that names no
number. **`submit:testflight` is the upload path.** `build:mas` is for building only.

### After it lands

Processing takes 5–30 minutes. Then install from TestFlight and check the thing no local
run can tell you: whether the sandbox lets the app reach a real config. The Apps page
should read your keybindings, or ask for
`/Users/<you>/Library/Application Support/Code/User` — a path with `Containers` in it
means the app is looking inside its own container again (see `realHome` in
`src/main/grants.ts`). Neither `npm run dev` nor the DMG build can surface that class of
bug: only a signed sandboxed build has a rewritten `HOME`.

## Verifying the DMG

### First, launch it

The hardened runtime is only applied to a _signed_ build, so an unsigned smoke build
tells you nothing about whether the real one starts. Hardened runtime plus a rejected
entitlement is the classic "notarized fine, dies on launch" failure, and
`build/entitlements.mac.plist` carries `allow-unsigned-executable-memory` and
`allow-dyld-environment-variables`.

Quit any `npm run dev` instance first (see the note below), then open the DMG and launch
the copy from inside it — not `dist/mac-universal/unikeys.app`. Only the copy that has
travelled through the disk image carries the quarantine attribute a real download gets,
which is what makes this the true first-run path:

```bash
open dist/unikeys-<version>.dmg
```

Drag to Applications, double-click, and confirm the window renders and at least one
app's row resolves a real config path.

### Then check the signature

`gatekeeperAssess: false` is set, so electron-builder does not check any of this for
you. Run these against the built artifacts, substituting the real version:

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-universal/unikeys.app
codesign -dv --entitlements - dist/mac-universal/unikeys.app
xcrun stapler validate dist/unikeys-<version>.dmg
spctl -a -t open --context context:primary-signature -vvv dist/unikeys-<version>.dmg
```

The last one is the real test: it is what a stranger's Mac does when they open the DMG.

## Notes

- **Testing a packaged build while `npm run dev` is running does not work.** Both share
  the same user data directory, and `requestSingleInstanceLock` in `src/main/index.ts`
  makes the second one quit immediately and silently. Quit the dev instance first, or
  pass `--user-data-dir=/tmp/somewhere` to the packaged binary.
- `NODE_OPTIONS` set in your shell will make a packaged Electron app log
  `Most NODE_OPTIONs are not supported in packaged apps`. Harmless, but noisy.
- `publish.url` in `electron-builder.yml` still points at `https://example.com/auto-updates`,
  which embeds a meaningless `app-update.yml`. Harmless — `electron-updater` is a
  dependency but is never imported. Worth removing both if auto-update stays out of scope.
