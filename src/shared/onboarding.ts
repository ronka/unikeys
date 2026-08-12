/**
 * The one decision behind the onboarding access step: which apps still need
 * something from the user before their config can be read.
 *
 * Pure and shared so the wizard's queue is testable without a renderer. The
 * caller freezes the result when the step begins — statuses refresh as grants
 * land, and a queue derived live would reshuffle under the user mid-walk.
 */

import { APP_IDS, type AppId } from './apps'
import type { AppHealth, AppStatus } from './ipc'

/**
 * The healths a user can fix by pointing at a folder. `grant-required` only
 * exists under the sandbox; the other two are an app whose config unikeys
 * cannot find or has no standard location for, which either build asks about.
 */
const SANDBOX_NEEDS: readonly AppHealth[] = [
  'grant-required',
  'config-path-required',
  'config-not-found'
]
const DMG_NEEDS: readonly AppHealth[] = ['config-path-required', 'config-not-found']

/**
 * The selected apps whose config the user has to locate, in `APP_IDS` order —
 * the same order as the table's columns, so the walkthrough reads like the app.
 */
export function accessQueue(
  statuses: readonly AppStatus[],
  selected: ReadonlySet<AppId>,
  sandboxed: boolean
): AppId[] {
  const needsInput = new Set(sandboxed ? SANDBOX_NEEDS : DMG_NEEDS)
  const byId = new Map(statuses.map((status) => [status.app, status.health]))
  return APP_IDS.filter((app) => {
    if (!selected.has(app)) return false
    const health = byId.get(app)
    return health !== undefined && needsInput.has(health)
  })
}
