/**
 * What became of each cell a save asked for.
 *
 * This governs data loss: the cells it calls settled are folded into the store,
 * and everything else stays pending so the table keeps showing it and the next
 * save retries it. It lives here, pure and tested, rather than in the renderer,
 * because the history page and the pending badge both read it — derived from one
 * computation they cannot disagree.
 */

import type { AppId } from '../apps'
import type { WriteResult } from '../ipc'
import { cellKey, type CellRef } from './reducer'

export type SaveOutcome =
  /** Reached the app's config file. */
  | 'written'
  /**
   * unikeys deliberately declined to write it — the app is off, or the
   * catalogue maps no command for it. Retrying cannot help, so the cell is
   * settled rather than left pending forever.
   */
  | 'settled'
  /** The app's format cannot express this chord. Bind something else. */
  | 'unsupported'
  /** unikeys could not read its own stored chord. A bug, not a user action. */
  | 'unreadable'
  /** The app's write or plan failed. Retrying may well help. */
  | 'failed'

export interface CellOutcome extends CellRef {
  outcome: SaveOutcome
}

/** True for the outcomes that mean "stop showing this cell as pending". */
export function isSettled(outcome: SaveOutcome): boolean {
  return outcome === 'written' || outcome === 'settled'
}

/**
 * Classifies every cell the renderer sent against what the write reported.
 *
 * Precedence matters and is deliberate. A binding that never reached an adapter
 * (`dropped`) is decided before anything app-level, because its reason is
 * specific to the cell and more useful than "the app failed". An app-level
 * failure then outranks a per-chord skip, since a file that did not get written
 * is the more actionable of the two.
 *
 * The function is total: a combination neither list explains falls through to
 * `failed`, which keeps the cell pending. Guessing `written` there would be the
 * one mistake that loses the user's edit.
 */
export function classifySaveOutcome(sent: readonly CellRef[], result: WriteResult): CellOutcome[] {
  const written = new Set<AppId>(result.written.map((app) => app.app))
  const failed = new Set<AppId>(result.failed.map((app) => app.app))
  const dropped = new Map(result.dropped.map((drop) => [cellKey(drop), drop.deliberate]))
  const skipped = new Set(result.skipped.map((skip) => cellKey(skip)))

  const classify = (cell: CellRef): SaveOutcome => {
    const deliberate = dropped.get(cellKey(cell))
    if (deliberate !== undefined) return deliberate ? 'settled' : 'unreadable'
    if (failed.has(cell.app)) return 'failed'
    if (skipped.has(cellKey(cell))) return 'unsupported'
    if (written.has(cell.app)) return 'written'
    return 'failed'
  }

  return sent.map((cell) => ({
    actionId: cell.actionId,
    app: cell.app,
    outcome: classify(cell)
  }))
}

/** Exactly the cells that reached disk, or that never needed to. */
export function savedCells(outcomes: readonly CellOutcome[]): CellRef[] {
  return outcomes
    .filter((cell) => isSettled(cell.outcome))
    .map(({ actionId, app }) => ({ actionId, app }))
}
