/**
 * Turning a history entry back into edits.
 *
 * Revert never writes. It produces the reducer actions that put the recorded
 * "before" values back into the pending overlay, and the user saves them like
 * any other change — so a revert is reviewed on the Pending page first and is
 * never a silent write to someone's config file.
 *
 * Pure, and separate from the page, so what it can and cannot put back is
 * testable on its own.
 */

import { parseCanonical } from '../chord'
import { type TableAction } from '../table/reducer'
import { count } from '../text'
import { revertibleChanges, unrevertibleChanges, type HistoryEntry } from './types'

export interface RevertPlan {
  actions: TableAction[]
  /**
   * Cells unikeys had never seen before this save. There is no value to put
   * back and no way to return a cell to never-seen, so they are left alone.
   */
  unseen: number
  /** Cells whose recorded chord unikeys can no longer parse. */
  unparseable: number
}

/**
 * Builds the edits that put an entry's recorded state back.
 *
 * One cell at a time, and that is the whole of it: an edit lands in the cell it
 * names and nowhere else, so restoring a row cell by cell restores exactly what
 * was recorded. (While rows could be linked this needed three ordered passes —
 * unlink everything first, restore, relink — because a write to one cell of a
 * linked row rewrote the rest of it.)
 */
export function planRevert(entry: HistoryEntry): RevertPlan {
  const actions: TableAction[] = []
  let unparseable = 0

  for (const change of revertibleChanges(entry)) {
    const previous = change.previous
    if (previous === undefined) continue

    if (previous.chord === null) {
      actions.push({ type: 'clearChord', actionId: change.actionId, app: change.app })
      continue
    }

    const chord = parseCanonical(previous.chord)
    if (chord === null) {
      // Falling back to `clearChord` would silently unbind a key the user still
      // has, so an unreadable record is reported rather than guessed at.
      unparseable += 1
      continue
    }
    actions.push({ type: 'setChord', actionId: change.actionId, app: change.app, chord })
  }

  return { actions, unseen: unrevertibleChanges(entry).length, unparseable }
}

/**
 * What the revert could not do, as sentence fragments for the caller to join.
 *
 * Here rather than in the page so the wording is testable and so `App` stays
 * orchestration: the plan already knows every limit it hit, and turning those
 * into prose is not the component's business.
 */
export function describeRevert(plan: RevertPlan): string[] {
  const notes: string[] = []

  if (plan.unseen > 0) {
    notes.push(
      `${count(plan.unseen, 'binding')} had no earlier value in unikeys, so ${
        plan.unseen === 1 ? 'it was' : 'they were'
      } left alone`
    )
  }
  if (plan.unparseable > 0) {
    notes.push(`${count(plan.unparseable, 'recorded chord')} could not be read`)
  }

  return notes
}
