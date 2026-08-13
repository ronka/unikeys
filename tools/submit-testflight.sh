#!/usr/bin/env bash
#
# Builds the Mac App Store package and delivers it to App Store Connect, where
# TestFlight picks it up.
#
# Deliberately not called `release:mas`. The DMG flow next to it is
# `release:mac`, and the two differ by one letter while shipping to entirely
# different places under entirely different rules — one notarized and
# self-hosted, one sandboxed and reviewed by Apple.
#
# Usage:
#   npm run submit:testflight              build, validate, upload
#   npm run check:testflight               build and validate, upload nothing
#   BUILD_NUMBER=62 npm run submit:testflight
#
set -euo pipefail

cd "$(dirname "$0")/.."

validate_only=false
if [[ "${1:-}" == "--validate-only" ]]; then
  validate_only=true
fi

version=$(node -p "require('./package.json').version")

# CFBundleVersion, and the only thing App Store Connect insists on: an upload
# whose build number is not above the last one is refused, in a version of that
# sentence that does not name the number it wanted. Derived from the commit
# count so a submission needs no version bump and no counter file to forget to
# commit — TestFlight builds are supposed to be cheap, and making each one cost
# a `1.1.1 -> 1.1.2` is what stops people from cutting them.
#
# `git rev-list --count` rises with every commit but is not guaranteed
# monotonic across a squash, a rebase or a build from a shorter branch, and a
# build number that goes *down* is the opaque rejection above. Hence the
# override: when that happens, pass the number by hand rather than making a
# commit to climb back over it.
build_number=${BUILD_NUMBER:-$(git rev-list --count HEAD)}

if ! [[ "$build_number" =~ ^[0-9]+$ ]]; then
  echo "Build number must be a plain integer, got '$build_number'." >&2
  exit 1
fi

# The Apple ID lives in the keychain rather than in this file, which is in a
# public repository. Reading the account name off the app-specific password's
# own entry means there is one place to set it up and nothing to keep in sync;
# `find-generic-password` without `-g` returns metadata only, so this neither
# unlocks the password nor prompts for it.
apple_id=${APPLE_ID:-$(
  security find-generic-password -s AC_PASSWORD 2>/dev/null |
    awk -F'"' '/"acct"<blob>=/ {print $4}'
)}

if [[ -z "$apple_id" ]]; then
  cat >&2 <<'MISSING'
No Apple ID to submit as.

Either set APPLE_ID, or store an app-specific password (created at
appleid.apple.com -> Sign-In and Security -> App-Specific Passwords) under the
account it belongs to:

  security add-generic-password -s AC_PASSWORD -a you@example.com -w

MISSING
  exit 1
fi

password=${APPLE_APP_SPECIFIC_PASSWORD:-@keychain:AC_PASSWORD}

echo "==> unikeys $version (build $build_number) as $apple_id"

# `--config.buildVersion` rather than a value in electron-builder.yml, because
# the number is a property of this submission and not of the project. Without
# it CFBundleVersion defaults to the marketing version, and a second TestFlight
# build of the same version is rejected — which is exactly what happened to
# 1.1.0.
npm run build:mas -- --config.buildVersion="$build_number"

app=dist/mas-universal/unikeys.app
pkg="dist/mas-universal/unikeys-$version-universal.pkg"

if [[ ! -f "$pkg" ]]; then
  echo "Expected $pkg, which the build did not produce." >&2
  exit 1
fi

# Checked rather than assumed: a config flag electron-builder decided not to
# honour would leave CFBundleVersion at the marketing version, and the first
# report of that would be a rejected upload after a full universal build and a
# 200 MB transfer.
stamped=$(plutil -extract CFBundleVersion raw "$app/Contents/Info.plist")
if [[ "$stamped" != "$build_number" ]]; then
  echo "Built app carries CFBundleVersion $stamped, expected $build_number." >&2
  exit 1
fi

# Always, and always before the upload. It is the same server-side check the
# upload runs and it delivers nothing, so it is the one way to find out that a
# submission is malformed while that is still a fixable problem: an uploaded
# build cannot be deleted, only expired, and it sits in TestFlight next to the
# good one until someone notices.
echo "==> Validating $pkg"
xcrun altool --validate-app -f "$pkg" -t macos -u "$apple_id" -p "$password"

if [[ "$validate_only" == true ]]; then
  echo "==> Validated only. Nothing was uploaded."
  exit 0
fi

echo "==> Uploading $pkg"
xcrun altool --upload-app -f "$pkg" -t macos -u "$apple_id" -p "$password"

cat <<DONE

==> Delivered. Processing takes roughly 5-30 minutes before the build appears
    in TestFlight. Export compliance is answered in the binary, so it should
    not stall waiting on that.
DONE
