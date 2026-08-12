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
  if (unpackaged === null) unpackaged = detectUnpackaged()
  return unpackaged
}

/**
 * The bookmark stood in for a grant that macOS never issued.
 *
 * A non-mas build returns no bookmarks from the open panel however politely it
 * is asked, and a `null` grant would read as "not granted" — leaving the
 * simulated flow stuck on the state it is meant to demonstrate leaving.
 */
export const SIMULATED_GRANT = 'simulated-sandbox-grant'

let unpackaged: boolean | null = null

function detectUnpackaged(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    return app.isPackaged === false
  } catch {
    // No Electron at all — the unit tests. Nothing to simulate for.
    return false
  }
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
