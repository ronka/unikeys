/**
 * The table reducer: every state transition the table can make, as one pure
 * function over the saved store.
 *
 * Two product decisions live here and nowhere else:
 *
 * 1. **Matching a row is one shot.** Matching writes one chord into every app
 *    the catalogue maps for that action, and into no other app — an editor
 *    action must never try to bind itself in the terminal. It is a copy, not a
 *    subscription: nothing is remembered afterwards, and a later edit to one
 *    cell changes that cell alone. This is the row-wide twin of `copyBindings`,
 *    and it is implemented in this module only, so the UI can never diverge
 *    from it.
 * 2. **Pending edits are held apart from the saved store.** The UI can show the
 *    user exactly what would be written before anything reaches disk, and
 *    discarding is a matter of dropping the overlay rather than undoing edits.
 *
 * The reducer is pure: no clock, no randomness, no I/O, and no mutation of its
 * input. Every transition returns fresh objects.
 */

import { APP_IDS, type AppId } from '../apps'
import { formatCanonical, parseCanonical, type Chord } from '../chord'
import { isMapped, type Catalogue, type CatalogueAction } from '../catalogue/types'
import {
  createEmptyStore,
  type ChordOrigin,
  type ChordTable,
  type Store,
  type StoredChord
} from '../store/types'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TableState {
  /** Last saved state. Only `markSaved` and `importBindings` change it. */
  store: Store
  /** Overlay of unsaved chord edits, same shape as `store.chords`. */
  pending: ChordTable
}

export function createTableState(store: Store = createEmptyStore()): TableState {
  return { store, pending: {} }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** One binding read out of an app's config or shipped defaults on first run. */
export interface ImportedBinding {
  actionId: string
  app: AppId
  /** `null` records an action the app deliberately leaves unbound. */
  chord: Chord | null
  /** Imports are never `'user'`: that origin means "set inside unikeys". */
  origin: Extract<ChordOrigin, 'default' | 'imported'>
}

export interface ImportPayload {
  bindings: ImportedBinding[]
  /** Set once the first-run import summary has been shown. */
  markFirstRunCompleted?: boolean
}

export type TableAction =
  | { type: 'setChord'; actionId: string; app: AppId; chord: Chord }
  | { type: 'clearChord'; actionId: string; app: AppId }
  /**
   * Gives every app the catalogue maps for this action the same chord — "make
   * this row agree", once. Nothing is remembered afterwards: a later edit to one
   * cell changes that cell alone. See `plannedMatch` for which cells move.
   *
   * `winningChord` is required when the row's mapped apps disagree; omit it only
   * when they already agree. `null` is a legitimate winner meaning "unbound
   * everywhere", so absence and `null` mean different things here.
   */
  | { type: 'matchRow'; actionId: string; winningChord?: Chord | null }
  /**
   * Copies every chord one app holds into the named apps — "make these match
   * that one", once. The column-wide twin of `matchRow`, and equally one-shot: a
   * later edit to `from` does not follow. See `plannedCopy` for which cells move.
   */
  | { type: 'copyBindings'; from: AppId; to: readonly AppId[] }
  | { type: 'discardPending' }
  /**
   * Folds pending edits into the saved store after a write.
   *
   * `cells` names exactly the cells that reached disk. Anything omitted stays
   * pending, which is what stops three separate failures from silently eating a
   * user's work: an app whose write failed, a chord the app's format could not
   * express, and an edit made while the save was already in flight. Omit
   * `cells` entirely to fold everything.
   */
  | { type: 'markSaved'; cells?: readonly CellRef[] }
  | { type: 'importBindings'; payload: ImportPayload }
  /**
   * Replaces the saved store with one loaded from disk. Pending edits are
   * dropped rather than rebased, because they were made against a different
   * store and silently reinterpreting them would be worse than losing them.
   */
  | { type: 'hydrate'; store: Store }
  | { type: 'setAppEnabled'; app: AppId; enabled: boolean }
  | { type: 'setAppConfigPath'; app: AppId; path: string | null }
  /**
   * Records the security-scoped bookmark the user just granted, keyed by the
   * directory it opens, so it is persisted with the rest of the store and
   * survives a quit. Only ever dispatched by the App Store build.
   *
   * Adds to the grants an app holds rather than replacing them. One app can
   * need two directories at once — a config symlinked into a dotfiles repo is
   * read through one and written through the other — and replacing meant each
   * grant revoked the last, so the two folders took turns being unreachable and
   * re-granting could never settle. Keying by directory is what makes adding
   * safe: granting the same folder twice updates its bookmark instead of
   * accumulating a second one.
   */
  | { type: 'grantApp'; app: AppId; directory: string; grant: string }
  /**
   * Marks the onboarding wizard finished — or, from Settings, un-finished, so
   * it can be replayed. Persistence is the store persist effect's business,
   * like every other store patch.
   */
  | { type: 'setOnboardingCompleted'; completed: boolean }

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

/** Pending overlaid on saved — what the table actually shows for a cell. */
export function effectiveChord(
  state: TableState,
  actionId: string,
  app: AppId
): StoredChord | undefined {
  const pending = state.pending[actionId]
  if (pending && app in pending) return pending[app]
  return state.store.chords[actionId]?.[app]
}

export function hasPendingChanges(state: TableState): boolean {
  return Object.keys(state.pending).length > 0
}

/** The apps the user has switched on. Disabled apps get no column and no write. */
export function enabledApps(store: Store): AppId[] {
  return APP_IDS.filter((app) => store.apps[app].enabled)
}

/**
 * The apps a row can bind: the ones the catalogue maps, whether or not they are
 * currently enabled. A disabled app is not written to disk, but matching still
 * gives it the row's chord — otherwise re-enabling an app would bring back a
 * stale binding the user thought they had settled.
 */
export function mappedApps(action: CatalogueAction): AppId[] {
  return APP_IDS.filter((app) => isMapped(action, app))
}

/**
 * The distinct chords a row currently holds, so the UI can ask which one wins
 * before matching. Cells unikeys knows nothing about are skipped; an explicit
 * unbinding is a real answer and is offered as a candidate.
 */
export interface MatchCandidate {
  chord: Chord | null
  /** Canonical form, or `null` for an unbound candidate. Handy as a React key. */
  canonical: string | null
  /** The mapped apps holding this chord. */
  apps: AppId[]
}

export function matchCandidates(state: TableState, action: CatalogueAction): MatchCandidate[] {
  const candidates: MatchCandidate[] = []
  for (const app of mappedApps(action)) {
    const stored = effectiveChord(state, action.id, app)
    if (stored === undefined) continue
    const canonical = stored.chord
    const existing = candidates.find((candidate) => candidate.canonical === canonical)
    if (existing) {
      existing.apps.push(app)
      continue
    }
    candidates.push({
      chord: canonical === null ? null : parseCanonical(canonical),
      canonical,
      apps: [app]
    })
  }
  return candidates
}

/** True when matching needs no decision from the user. */
export function canMatchWithoutWinner(state: TableState, action: CatalogueAction): boolean {
  return matchCandidates(state, action).length <= 1
}

/** One cell a copy or a match would change, and the value it would take. */
export interface PlannedWrite extends CellRef {
  value: StoredChord
}

/**
 * Which cells matching a row would change, given the chord that wins.
 *
 * A mapped cell unikeys has never seen counts as a change: an app that gained a
 * column after the row was last matched is exactly the cell the user is pressing
 * the button to fill. A cell that already holds the winning chord does not, so
 * matching never rewrites an `imported` origin into a `user` one for nothing.
 *
 * The button is enabled from this list and the reducer applies it, so what the
 * row says it will do and what it does come from one rule.
 */
export function plannedMatch(
  state: TableState,
  action: CatalogueAction,
  winner: Chord | null
): PlannedWrite[] {
  const value: StoredChord = {
    chord: winner === null ? null : formatCanonical(winner),
    origin: 'user'
  }
  return mappedApps(action)
    .filter((app) => effectiveChord(state, action.id, app)?.chord !== value.chord)
    .map((app) => ({ actionId: action.id, app, value }))
}

/**
 * What pressing Match on this row would do, so the button can say which it is
 * rather than being a press with no visible result — the failure a link toggle
 * whose two states looked identical had.
 *
 * `empty` and `settled` both leave nothing to do, and they are kept apart
 * because only one of them means the apps agree: a row unikeys holds no chord
 * for anywhere is not a row that has been settled.
 */
export type RowMatchState = 'available' | 'settled' | 'empty'

export function rowMatchState(state: TableState, action: CatalogueAction): RowMatchState {
  const candidates = matchCandidates(state, action)
  if (candidates.length === 0) return 'empty'
  if (candidates.length > 1) return 'available'
  return plannedMatch(state, action, candidates[0].chord).length === 0 ? 'settled' : 'available'
}

/**
 * Which cells copying `from`'s bindings into `to` would actually change.
 *
 * The UI counts these before asking the user to commit, and the reducer applies
 * exactly this list — so the number on the button and the change that happens
 * can never come from two different rules.
 *
 * Four kinds of cell are left alone, and each is its own answer rather than an
 * edge case: an action the source app cannot bind has nothing to copy; a source
 * cell unikeys has never seen would copy an absence rather than a chord; a
 * target the catalogue does not map cannot hold the binding at all; and a target
 * that already agrees is not a change. That last one is also why a row that was
 * just matched never appears here — its mapped apps already hold one chord, and
 * the source is one of them.
 *
 * The copied chord becomes `origin: 'user'`. Copying is a decision, and a cell
 * that keeps an `imported` origin would be overwritten by the next import.
 */
export function plannedCopy(
  state: TableState,
  catalogue: Catalogue,
  from: AppId,
  to: readonly AppId[]
): PlannedWrite[] {
  const targets = to.filter((app) => app !== from)
  const copies: PlannedWrite[] = []

  for (const action of catalogue.actions) {
    if (!isMapped(action, from)) continue
    const source = effectiveChord(state, action.id, from)
    if (source === undefined) continue
    const value: StoredChord = { chord: source.chord, origin: 'user' }

    for (const app of targets) {
      if (!isMapped(action, app)) continue
      if (effectiveChord(state, action.id, app)?.chord === value.chord) continue
      copies.push({ actionId: action.id, app, value })
    }
  }

  return copies
}

// ---------------------------------------------------------------------------
// The pending-changes view
// ---------------------------------------------------------------------------

/** One cell of the table, identified independently of any state. */
export interface CellRef {
  actionId: string
  app: AppId
}

/**
 * The canonical key for a cell. A NUL cannot occur in an action id or an app id,
 * so the join is unambiguous however odd a hand-edited store's ids are. Exported
 * so anything keying cells uses this one rather than inventing a second format
 * that only happens to agree with it.
 */
export function cellKey(ref: CellRef): string {
  return `${ref.actionId}\u0000${ref.app}`
}

export interface PendingChange {
  actionId: string
  actionName: string
  app: AppId
  /** What the saved store holds; `undefined` when unikeys had nothing here. */
  previous: StoredChord | undefined
  next: StoredChord
}

/**
 * Every unsaved cell edit, in catalogue order then column order, so the review
 * list reads in the same order as the table it came from.
 */
export function pendingChanges(state: TableState, catalogue: Catalogue): PendingChange[] {
  const changes: PendingChange[] = []
  const seen = new Set<string>()

  const emit = (actionId: string, actionName: string): void => {
    const row = state.pending[actionId]
    if (!row) return
    for (const app of APP_IDS) {
      const next = row[app]
      if (next === undefined) continue
      changes.push({
        actionId,
        actionName,
        app,
        previous: state.store.chords[actionId]?.[app],
        next
      })
    }
  }

  for (const action of catalogue.actions) {
    seen.add(action.id)
    emit(action.id, action.name)
  }
  // An id the catalogue no longer carries still has to be reviewable, or a
  // pending edit could be saved without ever being shown.
  for (const actionId of Object.keys(state.pending)) {
    if (!seen.has(actionId)) emit(actionId, actionId)
  }

  return changes
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * The catalogue the reducer resolves mappings against. Passed in rather than
 * held in state because it is shipped data, not user state — it must never end
 * up in the persisted store.
 */
export function tableReducer(
  state: TableState,
  action: TableAction,
  catalogue: Catalogue
): TableState {
  switch (action.type) {
    case 'setChord':
      return writeCell(state, action.actionId, action.app, {
        chord: formatCanonical(action.chord),
        origin: 'user'
      })

    case 'clearChord':
      // An unbinding is a value, not an absence: the app must be told to drop
      // the binding, which is why this is `chord: null` and not a deletion.
      return writeCell(state, action.actionId, action.app, {
        chord: null,
        origin: 'user'
      })

    case 'matchRow':
      return matchRow(state, catalogue, action.actionId, action)

    case 'copyBindings':
      // Through `writeCell` rather than straight into the overlay, so a copy is
      // pruned against the saved store like every other edit.
      return plannedCopy(state, catalogue, action.from, action.to).reduce(
        (current, copy) => writeCell(current, copy.actionId, copy.app, copy.value),
        state
      )

    case 'discardPending':
      return { store: state.store, pending: {} }

    case 'markSaved': {
      const saved = action.cells === undefined ? null : new Set(action.cells.map(cellKey))
      return {
        store: {
          ...state.store,
          chords: foldPending(state.store.chords, state.pending, saved)
        },
        // Anything that did not reach disk stays pending, so the table keeps
        // showing it as unsaved and the next save retries it.
        pending: retainUnsaved(state.pending, saved)
      }
    }

    case 'hydrate':
      return { store: action.store, pending: {} }

    case 'importBindings':
      return importBindings(state, action.payload)

    case 'setAppEnabled':
      return withAppConfig(state, action.app, { enabled: action.enabled })

    case 'setAppConfigPath':
      return withAppConfig(state, action.app, { configPath: action.path })

    case 'grantApp':
      return withAppConfig(state, action.app, {
        grants: { ...state.store.apps[action.app].grants, [action.directory]: action.grant }
      })

    case 'setOnboardingCompleted':
      return {
        ...state,
        store: { ...state.store, onboardingCompleted: action.completed }
      }

    default:
      return state
  }
}

/** Binds the catalogue once, for `useReducer` and anything else wanting arity 2. */
export function createTableReducer(
  catalogue: Catalogue
): (state: TableState, action: TableAction) => TableState {
  return (state, action) => tableReducer(state, action, catalogue)
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Writes one cell. Nothing follows it: matching is the only row-wide edit. */
function writeCell(
  state: TableState,
  actionId: string,
  app: AppId,
  value: StoredChord
): TableState {
  const pending = setPending(state.store.chords, state.pending, actionId, app, value)
  if (pending === state.pending) return state
  return { ...state, pending }
}

function matchRow(
  state: TableState,
  catalogue: Catalogue,
  actionId: string,
  request: { winningChord?: Chord | null }
): TableState {
  const action = catalogue.actions.find((candidate) => candidate.id === actionId)
  if (!action) return state

  const candidates = matchCandidates(state, action)
  const explicit = 'winningChord' in request && request.winningChord !== undefined

  let winner: Chord | null
  if (explicit) {
    winner = request.winningChord as Chord | null
  } else if (candidates.length > 1) {
    // The apps disagree and the caller supplied no winner. Picking one here
    // would silently discard a binding the user may have wanted, so the row is
    // left exactly as it is and the UI is expected to prompt.
    return state
  } else if (candidates.length === 1) {
    winner = candidates[0].chord
  } else {
    // Nothing to spread: unikeys holds no chord for any app in this row.
    return state
  }

  return plannedMatch(state, action, winner).reduce(
    (current, write) => writeCell(current, write.actionId, write.app, write.value),
    state
  )
}

function importBindings(state: TableState, payload: ImportPayload): TableState {
  const chords: ChordTable = { ...state.store.chords }

  for (const binding of payload.bindings) {
    const existing = chords[binding.actionId]?.[binding.app]
    // Anything the user set inside unikeys outranks what an app's config or
    // defaults say; import fills cells in, it never overwrites a decision.
    if (existing?.origin === 'user') continue
    chords[binding.actionId] = {
      ...chords[binding.actionId],
      [binding.app]: {
        chord: binding.chord === null ? null : formatCanonical(binding.chord),
        origin: binding.origin
      }
    }
  }

  return {
    ...state,
    store: {
      ...state.store,
      chords,
      firstRunCompleted: payload.markFirstRunCompleted === true || state.store.firstRunCompleted
    }
  }
}

function withAppConfig(
  state: TableState,
  app: AppId,
  patch: Partial<Store['apps'][AppId]>
): TableState {
  return {
    ...state,
    store: {
      ...state.store,
      apps: { ...state.store.apps, [app]: { ...state.store.apps[app], ...patch } }
    }
  }
}

// ---------------------------------------------------------------------------
// Overlay bookkeeping
// ---------------------------------------------------------------------------

/**
 * Records one pending cell value, dropping the entry again when it matches what
 * is already saved. Without that pruning an edit that undoes itself would still
 * show up in the pending-changes list and keep the save button live.
 */
function setPending(
  saved: ChordTable,
  pending: ChordTable,
  actionId: string,
  app: AppId,
  value: StoredChord
): ChordTable {
  const savedValue = saved[actionId]?.[app]
  // Compared on the chord alone. Re-entering the chord a cell already holds
  // only promotes its origin to 'user', which writes the same bytes to the same
  // file — surfacing that as a pending change would show the user a row reading
  // "⌘S → ⌘S" and a live Save button for a change that does nothing.
  const matchesSaved = savedValue !== undefined && savedValue.chord === value.chord
  const current = pending[actionId]

  if (matchesSaved) {
    if (!current || !(app in current)) return pending
    const row = { ...current }
    delete row[app]
    const next = { ...pending }
    if (Object.keys(row).length === 0) delete next[actionId]
    else next[actionId] = row
    return next
  }

  const existing = current?.[app]
  if (existing && existing.chord === value.chord && existing.origin === value.origin) return pending

  return { ...pending, [actionId]: { ...current, [app]: value } }
}

function foldPending(
  saved: ChordTable,
  pending: ChordTable,
  savedCells: ReadonlySet<string> | null
): ChordTable {
  const chords: ChordTable = { ...saved }
  for (const [actionId, row] of Object.entries(pending)) {
    const accepted = filterRow(actionId, row, savedCells, true)
    if (Object.keys(accepted).length === 0) continue
    chords[actionId] = { ...chords[actionId], ...accepted }
  }
  return chords
}

/** The pending cells that did not reach disk, which stay pending. */
function retainUnsaved(pending: ChordTable, savedCells: ReadonlySet<string> | null): ChordTable {
  if (savedCells === null) return {}
  const kept: ChordTable = {}
  for (const [actionId, row] of Object.entries(pending)) {
    const remaining = filterRow(actionId, row, savedCells, false)
    if (Object.keys(remaining).length > 0) kept[actionId] = remaining
  }
  return kept
}

function filterRow(
  actionId: string,
  row: Partial<Record<AppId, StoredChord>>,
  savedCells: ReadonlySet<string> | null,
  keepSaved: boolean
): Partial<Record<AppId, StoredChord>> {
  if (savedCells === null) return keepSaved ? row : {}
  return Object.fromEntries(
    Object.entries(row).filter(
      ([app]) => savedCells.has(cellKey({ actionId, app: app as AppId })) === keepSaved
    )
  )
}

// ---------------------------------------------------------------------------
// Chord helpers shared with the view
// ---------------------------------------------------------------------------

/** The parsed chord for a cell, or `null` when it is unbound or unreadable. */
export function chordOf(stored: StoredChord | undefined): Chord | null {
  if (!stored || stored.chord === null) return null
  return parseCanonical(stored.chord)
}
