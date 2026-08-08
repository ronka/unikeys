/**
 * Turning a history entry back into edits.
 *
 * Revert never writes. It produces the reducer actions that put the recorded
 * "before" values back into the pending overlay, and the user saves them like
 * any other change — so a revert is reviewed on the Pending page first and is
 * never a silent write to someone's config file.
 *
 * Pure, and separate from the page, because the ordering below is subtle enough
 * to be worth testing on its own.
 */

import type { Catalogue } from '../catalogue/types'
import { parseCanonical } from '../chord'
import {
  canLinkWithoutWinner,
  effectiveLinked,
  type TableAction,
  type TableState
} from '../table/reducer'
import { revertibleChanges, unrevertibleChanges, type HistoryEntry } from './types'

export interface RevertPlan {
  /** Dispatch in this order — it is load-bearing. See `planRevert`. */
  actions: TableAction[]
  /**
   * Cells unikeys had never seen before this save. There is no value to put
   * back and no way to return a cell to never-seen, so they are left alone.
   */
  unseen: number
  /** Cells whose recorded chord unikeys can no longer parse. */
  unparseable: number
  /** Rows whose link cannot be restored without the user choosing a winner. */
  needsWinner: string[]
}

/**
 * Builds the edits that put an entry's recorded state back.
 *
 * The ordering matters in one specific way. `writeCell` propagates to every
 * mapped app while a row is linked, so restoring a linked row's cells one at a
 * time would leave the whole row holding whichever cell happened to be last.
 * Any row this entry touches that is linked now — or that this very save
 * linked — is therefore unlinked *first*, which is exactly what `unlinkRow` is
 * for: it drops the flag and leaves the chords alone, so the per-cell writes
 * that follow land where they were aimed.
 *
 * Re-linking a row the save unlinked comes last, for the mirror-image reason:
 * `linkRow` reads the row's current chords to pick a winner, so it has to see
 * the restored values rather than the ones being replaced.
 *
 * `reduce` is the table reducer. The plan is projected through it as it is
 * built, so every guard judges the row as it will actually be at that point,
 * not as it was when the user clicked.
 */
export function planRevert(
  entry: HistoryEntry,
  state: TableState,
  catalogue: Catalogue,
  reduce: (state: TableState, action: TableAction) => TableState
): RevertPlan {
  const actions: TableAction[] = []
  const needsWinner: string[] = []
  let unparseable = 0
  let current = state

  const dispatch = (action: TableAction): void => {
    actions.push(action)
    current = reduce(current, action)
  }

  const changes = revertibleChanges(entry)
  const unseen = unrevertibleChanges(entry).length

  // Unlink first, once per row however many of its cells changed.
  const rowsToUnlink = new Set<string>()
  for (const actionId of new Set(changes.map((change) => change.actionId))) {
    if (effectiveLinked(current, actionId)) rowsToUnlink.add(actionId)
  }
  for (const link of entry.links) {
    // A row this save linked had its chords propagated by that link, so its
    // cells are in `changes` and need the same protection.
    if (link.linked) rowsToUnlink.add(link.actionId)
  }
  for (const actionId of rowsToUnlink) {
    dispatch({ type: 'unlinkRow', actionId })
  }

  for (const change of changes) {
    const previous = change.previous
    if (previous === undefined) continue

    if (previous.chord === null) {
      dispatch({ type: 'clearChord', actionId: change.actionId, app: change.app })
      continue
    }

    const chord = parseCanonical(previous.chord)
    if (chord === null) {
      // Falling back to `clearChord` would silently unbind a key the user still
      // has, so an unreadable record is reported rather than guessed at.
      unparseable += 1
      continue
    }
    dispatch({ type: 'setChord', actionId: change.actionId, app: change.app, chord })
  }

  for (const link of entry.links) {
    if (link.linked) continue // unlinked above; nothing more to do
    const action = catalogue.actions.find((candidate) => candidate.id === link.actionId)
    // `linkRow` returns the state untouched when the action is unknown, or when
    // the apps disagree and no winner was given. Both would be silent no-ops, so
    // they are reported instead of dispatched.
    if (!action || !canLinkWithoutWinner(current, action)) {
      needsWinner.push(link.actionName)
      continue
    }
    dispatch({ type: 'linkRow', actionId: link.actionId })
  }

  return { actions, unseen, unparseable, needsWinner }
}
