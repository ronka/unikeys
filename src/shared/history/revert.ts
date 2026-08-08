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
import { count } from '../text'
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
  /** Rows left unlinked because relinking them needs the user to pick a winner. */
  needsWinner: string[]
}

/** What a revert should leave a row's link flag set to, and the row's name. */
interface LinkTarget {
  name: string
  linked: boolean
}

/**
 * The link state each touched row should end up in.
 *
 * A row this save changed the link of is inverted — that is what undoing it
 * means. Every other touched row keeps the flag it has now, which is the part
 * that stops a revert from quietly unlinking a row it only meant to restore
 * chords in. Modelling it as a target rather than as "rows to unlink" plus
 * "links to undo" is what keeps the two from drifting apart.
 */
function linkTargets(entry: HistoryEntry, state: TableState): Map<string, LinkTarget> {
  const targets = new Map<string, LinkTarget>()
  for (const change of revertibleChanges(entry)) {
    targets.set(change.actionId, {
      name: change.actionName,
      linked: effectiveLinked(state, change.actionId)
    })
  }
  // Set second so it wins: what the save did to the link is the authoritative
  // statement about that row, whatever its cells say.
  for (const link of entry.links) {
    targets.set(link.actionId, { name: link.actionName, linked: !link.linked })
  }
  return targets
}

/**
 * Builds the edits that put an entry's recorded state back.
 *
 * Three passes, and the order is load-bearing.
 *
 * Every touched row is unlinked *first*, whatever it should end up as.
 * `writeCell` propagates to every mapped app while a row is linked, so restoring
 * a linked row's cells one at a time would leave the whole row holding whichever
 * cell happened to be last. `unlinkRow` drops the flag and leaves the chords
 * alone, so the per-cell writes that follow land where they were aimed.
 *
 * Relinking comes last for the mirror-image reason: `linkRow` reads the row's
 * current chords to pick a winner, so it has to see the restored values rather
 * than the ones being replaced. A row whose restored chords disagree cannot be
 * relinked without the user choosing between them, so it is reported instead —
 * silently leaving it unlinked would lose state the user never asked to drop.
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
  const targets = linkTargets(entry, state)

  for (const actionId of targets.keys()) {
    if (effectiveLinked(current, actionId)) dispatch({ type: 'unlinkRow', actionId })
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

  // Nothing in `targets` is linked by now — the first pass saw to that — so a
  // row wanting to be linked always needs an explicit `linkRow`.
  for (const [actionId, target] of targets) {
    if (!target.linked) continue
    const action = catalogue.actions.find((candidate) => candidate.id === actionId)
    // `linkRow` returns the state untouched when the action is unknown, or when
    // the apps disagree and no winner was given. Both would be silent no-ops, so
    // they are reported instead of dispatched.
    if (!action || !canLinkWithoutWinner(current, action)) {
      needsWinner.push(target.name)
      continue
    }
    dispatch({ type: 'linkRow', actionId })
  }

  return { actions, unseen, unparseable, needsWinner }
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
  if (plan.needsWinner.length > 0) {
    notes.push(
      `left ${plan.needsWinner.join(', ')} unlinked — those apps no longer agree, so relinking needs you to pick a chord`
    )
  }

  return notes
}
