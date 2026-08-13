/**
 * Security-scoped bookmarks: how a sandboxed build reaches a file it does not own.
 *
 * Under App Sandbox a process may read and write its own container and nothing
 * else, except for paths the user picked in a macOS file dialog. A bookmark is
 * that grant, frozen into a base64 blob that survives a quit — redeeming it
 * re-opens the door, and every filesystem call has to happen between the redeem
 * and the release.
 *
 * This module exists so `config-files.ts` is the only place that knows any of
 * that, and so the tests can exercise `config-files.ts` in plain Node: nothing
 * here touches Electron until a sandboxed build actually calls it.
 */

import { homedir, userInfo } from 'node:os'

import type { Grants } from '../shared/store/types'

/**
 * Whether grants are in force.
 *
 * `process.mas` is set by the Mac App Store Electron distribution, which is the
 * only build that ships the sandbox entitlements — so it answers "is this a
 * sandboxed build" without the app having to be told. In the dmg build this is
 * `false` and every function below becomes a no-op, which is what keeps the
 * existing release behaving exactly as it did.
 */
export function isSandboxed(): boolean {
  return process.mas === true || isSimulatedSandbox()
}

/**
 * A development-only pretence that this is a sandboxed build.
 *
 * The grant layer is otherwise unreachable outside the Mac App Store build, and
 * that build cannot even launch without an Apple distribution certificate — so
 * without this the entire flow (the "Needs access" state, the picker and where
 * it opens, the folder validation and its messages) could not be looked at at
 * all until the certificates existed.
 *
 * `npm run dev` sets `UNIKEYS_SIMULATE_SANDBOX=1` for you, because the App
 * Store build is the target: the default development run should behave like the
 * thing being shipped, not like the other build. `npm run dev:dmg` leaves it
 * unset and gives the unsandboxed behaviour.
 *
 * What it simulates is unikeys' half: the states, the prompts and the refusals.
 * It cannot simulate macOS's half — there is no real sandbox, so every path is
 * reachable anyway and a redeemed bookmark grants nothing because there was
 * nothing to grant. It therefore proves the UX and disproves nothing about
 * whether the sandbox will co-operate.
 *
 * Doubly gated, on the variable *and* on the build being unpackaged, so it
 * cannot be switched on in anything shipped.
 */
export function isSimulatedSandbox(): boolean {
  if (process.env.UNIKEYS_SIMULATE_SANDBOX !== '1') return false
  return buildKind() === 'unpackaged'
}

/**
 * A stand-in home directory, so unikeys can be run against the config files
 * checked into `dev-home/` instead of the ones on this machine.
 *
 * `realHome()` is the single place every standard config path and every
 * `~/Applications` install check is built from, so substituting it here is the
 * whole mechanism: thirteen apps' worth of configs and bundles appear without
 * one of them being installed. See `dev-home/README.md` and
 * `npm run dev:apps`, which sets this and `UNIKEYS_DEV_USER_DATA` together.
 *
 * `null` when unset, and — like `UNIKEYS_SIMULATE_SANDBOX` — always `null` in a
 * packaged build, so it cannot be switched on in anything shipped.
 */
export function devHome(): string | null {
  return devHomeFor(process.env.UNIKEYS_DEV_HOME, buildKind())
}

/**
 * The decision `devHome` makes, over its two inputs rather than over the
 * process.
 *
 * Split out because the half worth testing is the half that cannot be reached
 * from a test otherwise: `buildKind()` answers `no-electron` under vitest and
 * memoises, so there is no way to ask the real function what it does in a
 * packaged build — which is the one answer that matters, since getting it wrong
 * would let an environment variable move a shipped app's idea of home.
 */
export function devHomeFor(value: string | undefined, kind: BuildKind): string | null {
  if (!value) return null
  return kind === 'packaged' ? null : value
}

/**
 * Whether Electron says this is a packaged build, or is not there to ask.
 *
 * Three answers rather than two because the two callers want opposite things
 * from the third. `isSimulatedSandbox` wants `no-electron` to mean *off*: that
 * is the unit tests, which set `process.mas` themselves and would otherwise
 * find the simulation switched on underneath them by a stray environment
 * variable. `devHome` wants `no-electron` to mean *allowed*, because the test
 * that walks the checked-in tree runs in exactly that environment and a build
 * with no Electron in it is certainly not a shipped one.
 *
 * Collapsing this back to a boolean is what makes one of those two wrong.
 */
export type BuildKind = 'packaged' | 'unpackaged' | 'no-electron'

function buildKind(): BuildKind {
  if (kind === null) kind = detectBuildKind()
  return kind
}

/**
 * The bookmark stood in for a grant that macOS never issued.
 *
 * A non-mas build returns no bookmarks from the open panel however politely it
 * is asked, and a `null` grant would read as "not granted" — leaving the
 * simulated flow stuck on the state it is meant to demonstrate leaving.
 */
export const SIMULATED_GRANT = 'simulated-sandbox-grant'

let kind: BuildKind | null = null

function detectBuildKind(): BuildKind {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    return app.isPackaged ? 'packaged' : 'unpackaged'
  } catch {
    return 'no-electron'
  }
}

/**
 * The user's actual home directory, not the sandbox's idea of it.
 *
 * App Sandbox rewrites `HOME` to the app's container, so `os.homedir()` inside a
 * Mac App Store build answers
 * `~/Library/Containers/com.ronkaa.unikeys/Data` — and every standard config
 * path built on it points at a folder inside unikeys' own container that no
 * editor has ever written to. That is not a permissions problem the user can
 * fix: the picker opened at a path that does not exist, and the message naming
 * it named somewhere they have never been.
 *
 * `userInfo()` reads the passwd database rather than the environment, which is
 * the same answer `NSHomeDirectoryForUser(NSUserName())` gives and the one Apple
 * documents for exactly this. Knowing the real path grants nothing — the folder
 * is still unreachable until the user hands it over through the panel — it just
 * makes the path unikeys asks about the one the config is in.
 *
 * Only substituted under sandbox, so the dmg build keeps honouring a `HOME` its
 * user set on purpose.
 *
 * Not memoised, deliberately. The lookup is a local passwd read and the callers
 * are a status refresh's worth of path joins, so caching bought nothing — and a
 * cached answer that outlives a test's `HOME` is a test that keeps passing after
 * the fix it guards has been reverted.
 */
export function realHome(): string {
  // Before the sandbox question, not inside its unsandboxed arm. `npm run dev`
  // sets `UNIKEYS_SIMULATE_SANDBOX=1`, so a substitution made only where
  // `homedir()` is returned would be skipped by the default development run —
  // the one it exists for — and silently read the machine's real configs.
  return devHome() ?? (isSandboxed() ? readPasswdHome() : homedir())
}

function readPasswdHome(): string {
  try {
    return outsideContainer(userInfo().homedir || homedir())
  } catch {
    // The passwd lookup goes out to a directory service and can fail. The
    // environment's answer, with the container trimmed back off, is the same
    // path by a different route rather than a crash on startup.
    return outsideContainer(homedir())
  }
}

/**
 * A home directory with the container suffix removed, if it has one.
 *
 * The backstop for `userInfo()`, and never expected to fire: a container path is
 * always `<home>/Library/Containers/<bundle id>/Data`, so the real home is
 * recoverable from it by string alone. Kept because the whole of this module is
 * unreachable outside a signed Mac App Store build — if the passwd lookup ever
 * does answer with the container, the alternative to this line is a build that
 * cannot see a single config and a week of certificates to find out.
 *
 * Exported for the test that covers it, which is the only thing that can: no
 * development run has a container-shaped `HOME`, so this line cannot be reached
 * outside a signed store build by any other means.
 */
export function outsideContainer(home: string): string {
  const container = home.indexOf('/Library/Containers/')
  return container === -1 ? home : home.slice(0, container)
}

/** Releases a grant. Always safe to call, including when nothing was granted. */
export type ReleaseGrant = () => void

const RELEASE_NOTHING: ReleaseGrant = () => {}

/**
 * Opens every grant in `grants` for the duration of `work`.
 *
 * All of them together, not one at a time, because a single filesystem call can
 * straddle two: reading a config symlinked into a dotfiles repo opens a path
 * under the standard location and lands on a file in the repo, and only holding
 * both makes that succeed.
 *
 * Redeeming is reference-counted by macOS, so nesting is harmless and callers
 * do not have to reason about whether an outer scope already holds the same
 * bookmark. That is what lets `readConfig`, `ensureBackup` and `writeAtomic`
 * each redeem independently rather than having `apps-service.ts` wrap them —
 * which would mean `apps-service.ts` learning about bookmarks.
 *
 * No grants runs `work` unchanged. Outside the sandbox that is the whole story;
 * inside it, the call will fail on its own terms — as a plain `ENOENT`/`EPERM`
 * from the filesystem — and the caller reports that as a missing grant. Failing
 * at the syscall rather than here keeps one code path for "no grant" and "grant
 * no longer valid", which are the same problem to the user.
 */
export function withGrants<T>(grants: Grants, work: () => T): T {
  const releases = Object.values(grants).map(beginGrant)
  try {
    return work()
  } finally {
    for (const release of releases) release()
  }
}

function beginGrant(bookmark: string): ReleaseGrant {
  if (!isSandboxed()) return RELEASE_NOTHING

  try {
    // Required lazily. `config-files.ts` is exercised by the test suite in plain
    // Node with no Electron runtime, and a top-level import would drag the whole
    // module in for a branch that never runs there.
    //
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    // Typed as the bare `Function` by Electron; it is documented to take no
    // arguments and return nothing.
    return app.startAccessingSecurityScopedResource(bookmark) as ReleaseGrant
  } catch {
    // A bookmark that will not redeem is stale — the user moved or deleted the
    // folder. Nothing to do here: the filesystem call inside `work` fails next,
    // and that failure is what the UI turns into a re-prompt. Throwing instead
    // would replace a message about a specific config with a message about
    // bookmarks, which is not the user's vocabulary.
    return RELEASE_NOTHING
  }
}
