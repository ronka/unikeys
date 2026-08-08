/**
 * Building the record of one save.
 *
 * Here rather than in the renderer because this is where a save's pending
 * changes, the write's report and the per-cell classification meet — and getting
 * that meeting wrong is what would leave the log disagreeing with the table. It
 * is pure, so it can be tested directly.
 */

import type { WriteResult } from '../ipc'
import type { PendingChange, PendingLinkChange } from '../table/reducer'
import { classifySaveOutcome } from '../table/save-outcome'
import type { SaveEntryBody } from './types'

/**
 * What became of the write as a whole.
 *
 * A discriminated pair rather than a nullable result plus an optional message:
 * "the write reported back" and "the write threw" are the only two states, and
 * saying so in the type is what keeps the caller from having to construct
 * placeholder outcomes for the failing branch.
 */
export type WriteAttempt = { ok: true; result: WriteResult } | { ok: false; error: string }

/**
 * The record of one save.
 *
 * The per-cell outcomes are classified here, from the same `changes` the entry
 * is built out of, so the log and the pending badge cannot disagree — and so
 * there is no second array for the caller to keep index-aligned with this one.
 *
 * A write that threw settles nothing: every cell is recorded as not written, and
 * no app is claimed either way, because nothing can be said about disk.
 */
export function buildSaveEntry(
  changes: readonly PendingChange[],
  links: readonly PendingLinkChange[],
  attempt: WriteAttempt
): SaveEntryBody {
  const outcomes = attempt.ok
    ? classifySaveOutcome(changes, attempt.result)
    : changes.map((change) => ({
        actionId: change.actionId,
        app: change.app,
        outcome: 'failed' as const
      }))

  return {
    kind: 'save',
    changes: changes.map((change, i) => ({
      actionId: change.actionId,
      actionName: change.actionName,
      app: change.app,
      previous: change.previous,
      next: change.next,
      outcome: outcomes[i].outcome
    })),
    links: links.map((link) => ({
      actionId: link.actionId,
      actionName: link.actionName,
      linked: link.linked
    })),
    apps: attempt.ok
      ? [
          ...attempt.result.written.map((app) => ({ app: app.app, name: app.name, ok: true })),
          ...attempt.result.failed.map((app) => ({
            app: app.app,
            name: app.name,
            ok: false,
            error: app.error
          }))
        ]
      : [],
    ...(attempt.ok ? {} : { error: attempt.error })
  }
}
