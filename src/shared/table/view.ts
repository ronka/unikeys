/**
 * The renderable table, derived from state plus the catalogue.
 *
 * The renderer gets no say in what a cell means. Two distinctions are decided
 * here because both are user stories in their own right:
 *
 * - **not-applicable vs unbound.** A cell the catalogue maps no command for can
 *   never hold a chord; a mapped cell with no chord is a deliberate blank. They
 *   look similar and mean opposite things, so they are separate cell kinds.
 * - **divergence.** A row is divergent when its apps disagree — and only apps
 *   that could agree are counted. Not-applicable cells are excluded, so a
 *   terminal-only action never reads as divergent just because the editors have
 *   no equivalent for it.
 */

import { APP_IDS, type AppId } from '../apps'
import { formatDisplay, type Chord } from '../chord'
import {
  CATEGORIES,
  CATEGORY_LABELS,
  isMapped,
  type Catalogue,
  type CatalogueAction,
  type Category
} from '../catalogue/types'
import type { ChordOrigin } from '../store/types'
import {
  chordOf,
  effectiveChord,
  enabledApps,
  rowMatchState,
  type RowMatchState,
  type TableState
} from './reducer'

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export type CellState =
  | { kind: 'bound'; chord: Chord; display: string; origin: ChordOrigin; pending: boolean }
  /** Mapped, but deliberately not bound. */
  | { kind: 'unbound'; pending: boolean }
  /** The catalogue maps no command for this app, so there is nothing to bind. */
  | { kind: 'not-applicable' }

export function buildCellState(state: TableState, action: CatalogueAction, app: AppId): CellState {
  if (!isMapped(action, app)) return { kind: 'not-applicable' }

  const stored = effectiveChord(state, action.id, app)
  const pending = isCellPending(state, action.id, app)
  const chord = chordOf(stored)

  // A stored string the chord model cannot parse renders as unbound: it cannot
  // be shown or written, and pretending otherwise would promise a binding that
  // will never reach the app.
  if (stored === undefined || chord === null) return { kind: 'unbound', pending }

  return {
    kind: 'bound',
    chord,
    display: formatDisplay(chord),
    origin: stored.origin,
    pending
  }
}

function isCellPending(state: TableState, actionId: string, app: AppId): boolean {
  const row = state.pending[actionId]
  return row !== undefined && app in row
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface RowView {
  action: CatalogueAction
  /** One entry per enabled app, in `APP_IDS` order. */
  cells: Partial<Record<AppId, CellState>>
  divergent: boolean
  hasPending: boolean
  /**
   * What the row's Match button would do.
   *
   * Not derivable from `divergent`, which only compares the columns on screen:
   * a mapped app the user has switched off still takes the row's chord, so a
   * row can look settled and still have something to match.
   */
  match: RowMatchState
}

export function buildRowView(
  state: TableState,
  action: CatalogueAction,
  apps: readonly AppId[]
): RowView {
  const cells: Partial<Record<AppId, CellState>> = {}
  for (const app of apps) cells[app] = buildCellState(state, action, app)

  const comparable = apps.filter((app) => isMapped(action, app))
  // A row only one app can express has nothing to disagree with.
  const divergent =
    comparable.length > 1 &&
    comparable.some((app) => cellKey(cells[app]) !== cellKey(cells[comparable[0]]))

  const hasPending = apps.some((app) => isCellPending(state, action.id, app))

  return { action, cells, divergent, hasPending, match: rowMatchState(state, action) }
}

/**
 * The value two cells must share to count as agreeing. Unbound and
 * not-applicable both collapse to `null`, so "no chord here" never reads as a
 * disagreement with "no chord there".
 */
function cellKey(cell: CellState | undefined): string | null {
  if (!cell || cell.kind !== 'bound') return null
  return cell.display
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export interface CategoryGroup {
  category: Category
  label: string
  rows: RowView[]
}

export interface TableView {
  /** The columns, in `APP_IDS` order. */
  apps: AppId[]
  groups: CategoryGroup[]
  rowCount: number
  divergentCount: number
}

export interface TableViewOptions {
  /** Case-insensitive substring match on the action name or its id. */
  search?: string
  /**
   * Show only actions the catalogue maps a command for in this app. The other
   * apps keep their columns: the point is to answer "what can I bind here?"
   * without giving up the comparison that makes the table worth reading.
   */
  appFilter?: AppId
  /** Defaults to the apps enabled in the store. */
  enabledApps?: readonly AppId[]
}

export function buildTableView(
  state: TableState,
  catalogue: Catalogue,
  options: TableViewOptions = {}
): TableView {
  const apps = APP_IDS.filter((app) =>
    (options.enabledApps ?? enabledApps(state.store)).includes(app)
  )
  const query = (options.search ?? '').trim().toLowerCase()
  // A disabled app has no column, so filtering rows against it would hide rows
  // for a reason the user cannot see on screen.
  const appFilter =
    options.appFilter !== undefined && apps.includes(options.appFilter)
      ? options.appFilter
      : undefined

  const groups: CategoryGroup[] = []
  let rowCount = 0
  let divergentCount = 0

  // Fixed category order, so the table never reshuffles itself as rows change.
  for (const category of CATEGORIES) {
    const rows = catalogue.actions
      .filter(
        (action) =>
          action.category === category &&
          matches(action, query) &&
          (appFilter === undefined || isMapped(action, appFilter))
      )
      .map((action) => buildRowView(state, action, apps))

    rowCount += rows.length
    divergentCount += rows.filter((row) => row.divergent).length
    // An empty group is noise; a search that matches nothing here shows nothing.
    if (rows.length > 0) groups.push({ category, label: CATEGORY_LABELS[category], rows })
  }

  return { apps, groups, rowCount, divergentCount }
}

function matches(action: CatalogueAction, query: string): boolean {
  if (query === '') return true
  return action.name.toLowerCase().includes(query) || action.id.toLowerCase().includes(query)
}

// ---------------------------------------------------------------------------
// First-run summary
// ---------------------------------------------------------------------------

export interface ImportSummary {
  /** Catalogue actions the import found at least one chord for. */
  actionsFound: number
  /** Enabled apps that yielded at least one chord. */
  appsRead: AppId[]
  /** Rows whose apps disagree — where the user's divergence actually is. */
  divergentRows: number
}

/**
 * What to show after a first-run import: proof the tool read something real,
 * and the number that tells the user where to start.
 */
export function summarizeImport(
  state: TableState,
  catalogue: Catalogue,
  options: { enabledApps?: readonly AppId[] } = {}
): ImportSummary {
  const apps = APP_IDS.filter((app) =>
    (options.enabledApps ?? enabledApps(state.store)).includes(app)
  )
  const appsRead = new Set<AppId>()
  let actionsFound = 0
  let divergentRows = 0

  for (const action of catalogue.actions) {
    const row = buildRowView(state, action, apps)
    const bound = apps.filter((app) => row.cells[app]?.kind === 'bound')
    if (bound.length > 0) actionsFound += 1
    for (const app of bound) appsRead.add(app)
    if (row.divergent) divergentRows += 1
  }

  return { actionsFound, appsRead: APP_IDS.filter((app) => appsRead.has(app)), divergentRows }
}
