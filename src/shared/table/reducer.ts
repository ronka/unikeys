/**
 * The table reducer: every state transition the table can make, as one pure
 * function over the saved store.
 *
 * Two product decisions live here and nowhere else:
 *
 * 1. **Linked-row propagation.** Editing any cell of a linked row writes the
 *    same chord to every app the catalogue maps for that action, and to no
 *    other app — a linked editor action must never try to bind itself in the
 *    terminal. This is the feature the app is named for; it is implemented in
 *    this module only, so the UI can never diverge from it.
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

/**
 * Unsaved link/unlink changes, keyed by action id. A key is present only while
 * the desired state differs from the saved store, so an entry is always a real
 * change the user would see in the pending-changes view.
 */
export type PendingLinks = Record<string, boolean>

export interface TableState {
  /** Last saved state. Only `markSaved` and `importBindings` change it. */
  store: Store
  /** Overlay of unsaved chord edits, same shape as `store.chords`. */
  pending: ChordTable
  /** Overlay of unsaved link/unlink changes. */
  pendingLinks: PendingLinks
}

export function createTableState(store: Store = createEmptyStore()): TableState {
  return { store, pending: {}, pendingLinks: {} }
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
   * `winningChord` is required when the row's mapped apps disagree; omit it only
   * when they already agree. `null` is a legitimate winner meaning "unbound
   * everywhere", so absence and `null` mean different things here.
   */
  | { type: 'linkRow'; actionId: string; winningChord?: Chord | null }
  | { type: 'unlinkRow'; actionId: string }
  /**
   * Copies every chord one app holds into the named apps — "make these match
   * that one", once. It is not a link: nothing is remembered, and a later edit
   * to `from` does not follow. See `plannedCopy` for exactly which cells move.
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
   *
   * Pending link changes are always folded — linking is unikeys' own state, not
   * something a config file can reject.
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

/** Pending overlaid on saved — whether the row propagates edits. */
export function effectiveLinked(state: TableState, actionId: string): boolean {
  if (actionId in state.pendingLinks) return state.pendingLinks[actionId]
  return state.store.linkedActions.includes(actionId)
}

export function hasPendingChanges(state: TableState): boolean {
  return Object.keys(state.pending).length > 0 || Object.keys(state.pendingLinks).length > 0
}

/** The apps the user has switched on. Disabled apps get no column and no write. */
export function enabledApps(store: Store): AppId[] {
  return APP_IDS.filter((app) => store.apps[app].enabled)
}

/**
 * The apps a row propagates to: the ones the catalogue maps, whether or not
 * they are currently enabled. A disabled app is not written to disk, but its
 * stored chord still belongs to the linked row — otherwise re-enabling an app
 * would silently reintroduce a stale, unlinked chord.
 */
export function propagationTargets(action: CatalogueAction): AppId[] {
  return APP_IDS.filter((app) => isMapped(action, app))
}

/**
 * The distinct chords a row currently holds, so the UI can ask which one wins
 * before linking. Cells unikeys knows nothing about are skipped; an explicit
 * unbinding is a real answer and is offered as a candidate.
 */
export interface LinkCandidate {
  chord: Chord | null
  /** Canonical form, or `null` for an unbound candidate. Handy as a React key. */
  canonical: string | null
  /** The mapped apps holding this chord. */
  apps: AppId[]
}

export function linkCandidates(state: TableState, action: CatalogueAction): LinkCandidate[] {
  const candidates: LinkCandidate[] = []
  for (const app of propagationTargets(action)) {
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

/** True when linking needs no decision from the user. */
export function canLinkWithoutWinner(state: TableState, action: CatalogueAction): boolean {
  return linkCandidates(state, action).length <= 1
}

/** One cell a copy would change, and the value it would take. */
export interface PlannedCopy extends CellRef {
  value: StoredChord
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
 * that already agrees is not a change. That last one is also why a linked row
 * never appears here — its mapped apps already hold one chord, and the source is
 * one of them.
 *
 * The copied chord becomes `origin: 'user'`. Copying is a decision, and a cell
 * that keeps an `imported` origin would be overwritten by the next import.
 */
export function plannedCopy(
  state: TableState,
  catalogue: Catalogue,
  from: AppId,
  to: readonly AppId[]
): PlannedCopy[] {
  const targets = to.filter((app) => app !== from)
  const copies: PlannedCopy[] = []

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

export interface PendingLinkChange {
  actionId: string
  actionName: string
  linked: boolean
}

export function pendingLinkChanges(state: TableState, catalogue: Catalogue): PendingLinkChange[] {
  const names = new Map(catalogue.actions.map((action) => [action.id, action.name]))
  return Object.keys(state.pendingLinks).map((actionId) => ({
    actionId,
    actionName: names.get(actionId) ?? actionId,
    linked: state.pendingLinks[actionId]
  }))
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
      return writeCell(state, catalogue, action.actionId, action.app, {
        chord: formatCanonical(action.chord),
        origin: 'user'
      })

    case 'clearChord':
      // An unbinding is a value, not an absence: the app must be told to drop
      // the binding, which is why this is `chord: null` and not a deletion.
      return writeCell(state, catalogue, action.actionId, action.app, {
        chord: null,
        origin: 'user'
      })

    case 'linkRow':
      return linkRow(state, catalogue, action.actionId, action)

    case 'unlinkRow':
      // Nothing else to do. Linking kept every mapped cell equal, so simply
      // dropping the id is what leaves each app holding the last shared chord
      // rather than reverting to what it held before linking.
      return setLinked(state, action.actionId, false)

    case 'copyBindings':
      // Through `writeCell` rather than straight into the overlay, so a copy
      // obeys the same propagation rule every other edit does.
      return plannedCopy(state, catalogue, action.from, action.to).reduce(
        (current, copy) => writeCell(current, catalogue, copy.actionId, copy.app, copy.value),
        state
      )

    case 'discardPending':
      return { store: state.store, pending: {}, pendingLinks: {} }

    case 'markSaved': {
      const saved = action.cells === undefined ? null : new Set(action.cells.map(cellKey))
      return {
        store: {
          ...state.store,
          chords: foldPending(state.store.chords, state.pending, saved),
          linkedActions: foldPendingLinks(state.store.linkedActions, state.pendingLinks)
        },
        // Anything that did not reach disk stays pending, so the table keeps
        // showing it as unsaved and the next save retries it.
        pending: retainUnsaved(state.pending, saved),
        pendingLinks: {}
      }
    }

    case 'hydrate':
      return { store: action.store, pending: {}, pendingLinks: {} }

    case 'importBindings':
      return importBindings(state, action.payload)

    case 'setAppEnabled':
      return withAppConfig(state, action.app, { enabled: action.enabled })

    case 'setAppConfigPath':
      return withAppConfig(state, action.app, { configPath: action.path })

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

/**
 * Writes one cell, or — when the row is linked — the same value to every mapped
 * app in the row. The edited app is written even if the catalogue does not map
 * it, because the user explicitly asked for that cell; propagation is what is
 * restricted to mapped apps.
 */
function writeCell(
  state: TableState,
  catalogue: Catalogue,
  actionId: string,
  app: AppId,
  value: StoredChord
): TableState {
  const action = catalogue.actions.find((candidate) => candidate.id === actionId)
  const targets =
    action && effectiveLinked(state, actionId) ? propagationTargets(action) : ([] as AppId[])
  const apps = targets.includes(app) ? targets : [app, ...targets]

  let pending = state.pending
  for (const target of apps) {
    pending = setPending(state.store.chords, pending, actionId, target, value)
  }
  if (pending === state.pending) return state
  return { ...state, pending }
}

function linkRow(
  state: TableState,
  catalogue: Catalogue,
  actionId: string,
  request: { winningChord?: Chord | null }
): TableState {
  const action = catalogue.actions.find((candidate) => candidate.id === actionId)
  if (!action) return state

  const candidates = linkCandidates(state, action)
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
    // Nothing to share yet; link the empty row and let the first edit fill it.
    return setLinked(state, actionId, true)
  }

  const value: StoredChord = {
    chord: winner === null ? null : formatCanonical(winner),
    origin: 'user'
  }
  let pending = state.pending
  for (const target of propagationTargets(action)) {
    // A cell that already holds the winning chord is left untouched so linking
    // does not rewrite an imported origin into a user one for no reason.
    const current = effectiveChord(state, actionId, target)
    if (current !== undefined && current.chord === value.chord) continue
    pending = setPending(state.store.chords, pending, actionId, target, value)
  }

  return setLinked({ ...state, pending }, actionId, true)
}

function importBindings(state: TableState, payload: ImportPayload): TableState {
  const chords: ChordTable = { ...state.store.chords }

  const linked = new Set(state.store.linkedActions)

  for (const binding of payload.bindings) {
    // A linked row is a decision the user made about the whole row. Importing
    // into one of its cells would knock that cell out of sync with the rest and
    // leave the row rendering as linked *and* divergent, with nothing pending
    // to explain it.
    if (linked.has(binding.actionId)) continue

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

function setLinked(state: TableState, actionId: string, linked: boolean): TableState {
  const saved = state.store.linkedActions.includes(actionId)
  const pendingLinks = { ...state.pendingLinks }
  if (saved === linked) delete pendingLinks[actionId]
  else pendingLinks[actionId] = linked
  return { ...state, pendingLinks }
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

function foldPendingLinks(saved: readonly string[], pendingLinks: PendingLinks): string[] {
  const linked = new Set(saved)
  for (const [actionId, isLinkedNow] of Object.entries(pendingLinks)) {
    if (isLinkedNow) linked.add(actionId)
    else linked.delete(actionId)
  }
  return [...linked]
}

// ---------------------------------------------------------------------------
// Chord helpers shared with the view
// ---------------------------------------------------------------------------

/** The parsed chord for a cell, or `null` when it is unbound or unreadable. */
export function chordOf(stored: StoredChord | undefined): Chord | null {
  if (!stored || stored.chord === null) return null
  return parseCanonical(stored.chord)
}
