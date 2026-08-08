# Releasing unikeys for macOS

unikeys is distributed as a **signed, notarized universal DMG** that you host yourself —
not through the Mac App Store. The App Store requires App Sandbox, and a sandboxed app
cannot read or write the config files unikeys exists to edit
(`~/Library/Application Support/Code/User/keybindings.json`, `~/.config/ghostty/config`,
JetBrains keymap directories, Obsidian vaults). Developer ID is the only distribution
route on which the app actually works.

Bundle identifier: `com.ronkaa.unikeys`.

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

## Verifying the result

### First, launch it

The hardened runtime is only applied to a *signed* build, so an unsigned smoke build
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
