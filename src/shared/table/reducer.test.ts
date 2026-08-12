import { describe, expect, it } from 'vitest'
import { APP_IDS, APPS } from '../apps'
import { ACTIONS, CATALOGUE } from '../catalogue'
import { chord, parseCanonical, stroke } from '../chord'
import type { Catalogue } from '../catalogue/types'
import {
  createEmptyStore,
  deserializeStore,
  isCellUnseen,
  serializeStore,
  type Store,
  type StoredChord
} from '../store/types'
import {
  canMatchWithoutWinner,
  createTableState,
  effectiveChord,
  hasPendingChanges,
  matchCandidates,
  pendingChanges,
  plannedCopy,
  rowMatchState,
  tableReducer,
  type TableAction,
  type TableState
} from './reducer'

// A catalogue small enough to reason about: one action every app maps, one only
// the terminal maps, and one only the editors map.
const catalogue: Catalogue = {
  version: 1,
  actions: [
    {
      id: 'file.save',
      name: 'Save',
      category: 'editing',
      commands: {
        vscode: 'workbench.action.files.save',
        cursor: 'workbench.action.files.save',
        webstorm: 'SaveDocument',
        ghostty: 'write_screen_file'
      }
    },
    {
      id: 'terminal.split-right',
      name: 'Split Pane Right',
      category: 'terminal',
      commands: { ghostty: 'new_split:right' }
    },
    {
      id: 'edit.comment-line',
      name: 'Toggle Line Comment',
      category: 'editing',
      commands: {
        vscode: 'editor.action.commentLine',
        cursor: 'editor.action.commentLine',
        webstorm: 'CommentByLineComment'
      }
    }
  ]
}

const save = chord(stroke('s', 'cmd'))
const saveAll = chord(stroke('s', 'alt', 'cmd'))

function run(state: TableState, ...actions: TableAction[]): TableState {
  return actions.reduce((current, action) => tableReducer(current, action, catalogue), state)
}

function storeWith(chords: Store['chords']): Store {
  return { ...createEmptyStore(), chords }
}

function imported(canonical: string | null): StoredChord {
  return { chord: canonical, origin: 'imported' }
}

function canonicalOf(
  state: TableState,
  actionId: string,
  app: 'vscode' | 'cursor' | 'webstorm' | 'ghostty'
): string | null | undefined {
  return effectiveChord(state, actionId, app)?.chord
}

describe('editing a cell', () => {
  it('touches only the edited cell, whatever the rest of the row holds', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), cursor: imported('cmd+s') } })
    )

    const next = run(state, {
      type: 'setChord',
      actionId: 'file.save',
      app: 'vscode',
      chord: saveAll
    })

    expect(canonicalOf(next, 'file.save', 'vscode')).toBe('alt+cmd+s')
    expect(canonicalOf(next, 'file.save', 'cursor')).toBe('cmd+s')
    expect(canonicalOf(next, 'file.save', 'webstorm')).toBeUndefined()
  })

  it('does not follow a row that was matched a moment ago', () => {
    // The whole of the one-shot rule: matching settles the row, and the next
    // edit is an ordinary edit to one cell rather than a change to all of them.
    const state = createTableState(
      storeWith({ 'edit.comment-line': { vscode: imported('cmd+/') } })
    )

    const next = run(
      state,
      { type: 'matchRow', actionId: 'edit.comment-line' },
      { type: 'setChord', actionId: 'edit.comment-line', app: 'vscode', chord: save }
    )

    expect(canonicalOf(next, 'edit.comment-line', 'vscode')).toBe('cmd+s')
    expect(canonicalOf(next, 'edit.comment-line', 'cursor')).toBe('cmd+/')
    expect(canonicalOf(next, 'edit.comment-line', 'webstorm')).toBe('cmd+/')
  })

  it('records a user origin for edits', () => {
    const state = createTableState(storeWith({ 'file.save': { vscode: imported('cmd+s') } }))
    const next = run(state, {
      type: 'setChord',
      actionId: 'file.save',
      app: 'vscode',
      chord: saveAll
    })
    expect(effectiveChord(next, 'file.save', 'vscode')).toEqual({
      chord: 'alt+cmd+s',
      origin: 'user'
    })
  })

  it('clears a cell to an explicit unbinding rather than deleting it', () => {
    const state = createTableState(
      storeWith({
        'edit.comment-line': { vscode: imported('cmd+/'), cursor: imported('cmd+/') }
      })
    )

    const next = run(state, { type: 'clearChord', actionId: 'edit.comment-line', app: 'cursor' })

    // The app has to be told to drop the binding, so an unbinding is a value.
    expect(effectiveChord(next, 'edit.comment-line', 'cursor')).toEqual({
      chord: null,
      origin: 'user'
    })
    expect(canonicalOf(next, 'edit.comment-line', 'vscode')).toBe('cmd+/')
  })

  it('leaves the saved store untouched and does not mutate its input', () => {
    const store = storeWith({ 'file.save': { vscode: imported('cmd+s') } })
    const state = createTableState(store)
    const snapshot = JSON.stringify(state)

    run(state, { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: saveAll })

    expect(JSON.stringify(state)).toBe(snapshot)
    expect(store.chords['file.save'].vscode).toEqual(imported('cmd+s'))
  })
})

describe('matching a row', () => {
  it('reports the distinct existing chords of a divergent row', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: imported('cmd+s'),
          cursor: imported('cmd+s'),
          webstorm: imported('ctrl+s')
        }
      })
    )

    const candidates = matchCandidates(state, catalogue.actions[0])

    expect(candidates.map((candidate) => candidate.canonical)).toEqual(['cmd+s', 'ctrl+s'])
    expect(candidates[0].apps).toEqual(['vscode', 'cursor'])
    expect(candidates[1].apps).toEqual(['webstorm'])
    expect(canMatchWithoutWinner(state, catalogue.actions[0])).toBe(false)
  })

  it('refuses to pick a winner for a divergent row', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), webstorm: imported('ctrl+s') } })
    )

    const next = run(state, { type: 'matchRow', actionId: 'file.save' })

    expect(next).toBe(state)
  })

  it('applies the winning chord to every mapped app', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), webstorm: imported('ctrl+s') } })
    )

    const next = run(state, {
      type: 'matchRow',
      actionId: 'file.save',
      winningChord: parseCanonical('ctrl+s')!
    })

    for (const app of ['vscode', 'cursor', 'webstorm', 'ghostty'] as const) {
      expect(canonicalOf(next, 'file.save', app)).toBe('ctrl+s')
    }
  })

  /**
   * The other matching tests run against the small fixture catalogue above, so
   * none of them says what happens at thirteen columns. This one runs against
   * the shipped catalogue: with the table this wide a match reaches across
   * categories at once — editors, terminals and Obsidian — and the apps it
   * reaches are exactly the mapped ones, never the whole column set.
   */
  it('reaches every mapped app of the shipped thirteen, and no other', () => {
    const action = ACTIONS.find((candidate) => candidate.id === 'navigate.command-palette')!
    const mapped = APP_IDS.filter((app) => action.commands[app] !== undefined)
    const unmapped = APP_IDS.filter((app) => action.commands[app] === undefined)

    // The row is worth this test only if it really does span the table.
    expect(mapped.length).toBeGreaterThan(6)
    expect(unmapped.length).toBeGreaterThan(0)
    expect(mapped).toContain('obsidian')
    expect(new Set(mapped.map((app) => APPS[app].category)).size).toBeGreaterThan(1)

    const state = createTableState(
      storeWith({ 'navigate.command-palette': { vscode: imported('shift+cmd+p') } })
    )
    const next = tableReducer(
      state,
      {
        type: 'matchRow',
        actionId: 'navigate.command-palette',
        winningChord: parseCanonical('cmd+k')!
      },
      CATALOGUE
    )

    for (const app of mapped) {
      expect(
        effectiveChord(next, 'navigate.command-palette', app)?.chord,
        `${app} did not receive the row's chord`
      ).toBe('cmd+k')
    }
    // An unmapped app has no cell to fill, so matching must not invent one.
    for (const app of unmapped) {
      expect(
        effectiveChord(next, 'navigate.command-palette', app),
        `${app} is unmapped and should have been left alone`
      ).toBeUndefined()
    }
  })

  it('needs no winner when every mapped app already agrees', () => {
    const state = createTableState(
      storeWith({
        'edit.comment-line': {
          vscode: imported('cmd+/'),
          cursor: imported('cmd+/'),
          webstorm: imported('cmd+/')
        }
      })
    )

    expect(canMatchWithoutWinner(state, catalogue.actions[2])).toBe(true)
    expect(rowMatchState(state, catalogue.actions[2])).toBe('settled')

    const next = run(state, { type: 'matchRow', actionId: 'edit.comment-line' })

    // Nothing changed, so nothing is pending and the imported origins survive.
    expect(pendingChanges(next, catalogue)).toEqual([])
    expect(effectiveChord(next, 'edit.comment-line', 'vscode')).toEqual(imported('cmd+/'))
  })

  /**
   * The case a standing link never handled: an app unikeys gained a column for
   * after the row was settled. Its cell is empty, so the row is not finished
   * even though every app that has a chord agrees — and pressing Match is what
   * fills it.
   */
  it('fills a mapped app that has no chord yet, and says so beforehand', () => {
    const state = createTableState(storeWith({ 'file.save': { vscode: imported('cmd+s') } }))

    expect(canMatchWithoutWinner(state, catalogue.actions[0])).toBe(true)
    expect(rowMatchState(state, catalogue.actions[0])).toBe('available')

    const next = run(state, { type: 'matchRow', actionId: 'file.save' })

    expect(canonicalOf(next, 'file.save', 'ghostty')).toBe('cmd+s')
    expect(effectiveChord(next, 'file.save', 'ghostty')?.origin).toBe('user')
    expect(rowMatchState(next, catalogue.actions[0])).toBe('settled')
  })

  it('has nothing to spread for a row unikeys knows nothing about', () => {
    const state = createTableState(createEmptyStore())

    // 'empty', not 'settled': no app agreed to anything, and a tick claiming
    // they had would be a row lying about itself.
    expect(rowMatchState(state, catalogue.actions[0])).toBe('empty')
    expect(run(state, { type: 'matchRow', actionId: 'file.save' })).toBe(state)
  })

  it('accepts an explicit unbinding as the winner', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), webstorm: imported('ctrl+s') } })
    )

    const next = run(state, { type: 'matchRow', actionId: 'file.save', winningChord: null })

    for (const app of ['vscode', 'cursor', 'webstorm', 'ghostty'] as const) {
      expect(canonicalOf(next, 'file.save', app)).toBeNull()
    }
  })

  it('lands as pending changes, so a match is reviewed before it is written', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), webstorm: imported('ctrl+s') } })
    )

    const next = run(state, { type: 'matchRow', actionId: 'file.save', winningChord: save })

    expect(next.store).toBe(state.store)
    // VSCode already held the winner, so it is not rewritten just to promote
    // its origin; the other three are the change the user reviews.
    expect(pendingChanges(next, catalogue).map((change) => change.app)).toEqual([
      'cursor',
      'webstorm',
      'ghostty'
    ])
  })
})

describe('saving', () => {
  it('marks only the apps that were actually written, keeping the rest pending', () => {
    const edited = run(
      createTableState(),
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: save },
      { type: 'setChord', actionId: 'file.save', app: 'ghostty', chord: saveAll }
    )

    // VSCode took the write; Ghostty failed.
    const afterPartial = run(edited, {
      type: 'markSaved',
      cells: [{ actionId: 'file.save', app: 'vscode' }]
    })

    expect(afterPartial.store.chords['file.save']?.vscode?.chord).toBe('cmd+s')
    // Ghostty's edit never reached disk, so it must still read as pending
    // rather than being silently folded in as if it had been saved.
    expect(afterPartial.store.chords['file.save']?.ghostty).toBeUndefined()
    expect(afterPartial.pending['file.save']?.ghostty?.chord).toBe('alt+cmd+s')
    expect(hasPendingChanges(afterPartial)).toBe(true)

    // Retrying the failed app then clears it.
    const afterRetry = run(afterPartial, {
      type: 'markSaved',
      cells: [{ actionId: 'file.save', app: 'ghostty' }]
    })
    expect(afterRetry.store.chords['file.save']?.ghostty?.chord).toBe('alt+cmd+s')
    expect(hasPendingChanges(afterRetry)).toBe(false)
  })

  it('leaves an edit made while a save was in flight pending', () => {
    // The request was built from the VSCode edit alone; the Ghostty edit landed
    // afterwards and was never sent, so it must not be marked saved.
    const state = run(
      createTableState(),
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: save },
      { type: 'setChord', actionId: 'file.save', app: 'ghostty', chord: saveAll },
      { type: 'markSaved', cells: [{ actionId: 'file.save', app: 'vscode' }] }
    )
    expect(state.pending['file.save']?.ghostty?.chord).toBe('alt+cmd+s')
  })

  it('folds every pending edit when markSaved names no cells', () => {
    const edited = run(
      createTableState(),
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: save },
      { type: 'setChord', actionId: 'file.save', app: 'ghostty', chord: saveAll },
      { type: 'markSaved' }
    )
    expect(hasPendingChanges(edited)).toBe(false)
    expect(edited.store.chords['file.save']?.vscode?.chord).toBe('cmd+s')
    expect(edited.store.chords['file.save']?.ghostty?.chord).toBe('alt+cmd+s')
  })

  it('hydrates a store loaded from disk, dropping edits made against the old one', () => {
    const dirty = run(createTableState(), {
      type: 'setChord',
      actionId: 'file.save',
      app: 'vscode',
      chord: save
    })
    expect(hasPendingChanges(dirty)).toBe(true)

    const fromDisk = run(
      createTableState(),
      { type: 'setChord', actionId: 'file.save', app: 'cursor', chord: saveAll },
      { type: 'markSaved' }
    ).store

    const hydrated = run(dirty, { type: 'hydrate', store: fromDisk })
    expect(hydrated.store).toBe(fromDisk)
    // The pending edit was made against a different store, so it is dropped
    // rather than silently reinterpreted against this one.
    expect(hasPendingChanges(hydrated)).toBe(false)
    expect(canonicalOf(hydrated, 'file.save', 'cursor')).toBe('alt+cmd+s')
    expect(canonicalOf(hydrated, 'file.save', 'vscode')).toBeUndefined()
  })

  it('survives a store serialise/deserialise round trip', () => {
    const matched = run(
      createTableState(storeWith({ 'file.save': { vscode: imported('cmd+s') } })),
      { type: 'matchRow', actionId: 'file.save' },
      { type: 'markSaved' }
    )

    const outcome = deserializeStore(serializeStore(matched.store))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const reloaded = createTableState(outcome.store)
    for (const app of ['vscode', 'cursor', 'webstorm', 'ghostty'] as const) {
      expect(canonicalOf(reloaded, 'file.save', app)).toBe('cmd+s')
    }
  })

  /**
   * A store written while rows could be linked. The flag is read past rather
   * than migrated: the cells it kept equal are still equal, which is the state
   * the user was looking at, and nothing in the table asks about it any more.
   */
  it('reads a store written before matching replaced linking', () => {
    const legacy = JSON.stringify({
      schemaVersion: 1,
      apps: {},
      chords: { 'file.save': { vscode: { chord: 'cmd+s', origin: 'user' } } },
      linkedActions: ['file.save'],
      firstRunCompleted: true
    })

    const outcome = deserializeStore(legacy)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.store).not.toHaveProperty('linkedActions')
    expect(outcome.store.chords['file.save'].vscode?.chord).toBe('cmd+s')
    expect(outcome.store.firstRunCompleted).toBe(true)
  })
})

describe('copying one app’s bindings into others', () => {
  it('copies every chord the source holds into the apps that can bind it', () => {
    const state = createTableState(
      storeWith({
        'file.save': { cursor: imported('cmd+s') },
        'edit.comment-line': { cursor: imported('cmd+/') }
      })
    )

    const next = run(state, { type: 'copyBindings', from: 'cursor', to: ['vscode', 'ghostty'] })

    expect(canonicalOf(next, 'file.save', 'vscode')).toBe('cmd+s')
    expect(canonicalOf(next, 'file.save', 'ghostty')).toBe('cmd+s')
    // Ghostty maps no comment-line command, so it cannot take that one.
    expect(canonicalOf(next, 'edit.comment-line', 'vscode')).toBe('cmd+/')
    expect(canonicalOf(next, 'edit.comment-line', 'ghostty')).toBeUndefined()
  })

  it('leaves the source, unnamed apps and unseen cells alone', () => {
    const state = createTableState(storeWith({ 'file.save': { cursor: imported('cmd+s') } }))

    const next = run(state, { type: 'copyBindings', from: 'cursor', to: ['vscode', 'cursor'] })

    expect(canonicalOf(next, 'file.save', 'cursor')).toBe('cmd+s')
    expect(canonicalOf(next, 'file.save', 'webstorm')).toBeUndefined()
    // Nothing is known for this row, so there is no absence to spread.
    expect(canonicalOf(next, 'terminal.split-right', 'ghostty')).toBeUndefined()
  })

  it('copies a deliberate unbinding, which is a value like any other', () => {
    const state = createTableState(
      storeWith({ 'file.save': { cursor: imported(null), vscode: imported('cmd+s') } })
    )

    const next = run(state, { type: 'copyBindings', from: 'cursor', to: ['vscode'] })

    expect(canonicalOf(next, 'file.save', 'vscode')).toBeNull()
  })

  it('marks copied cells as the user’s, so the next import cannot undo them', () => {
    const state = createTableState(storeWith({ 'file.save': { cursor: imported('cmd+s') } }))

    const next = run(state, { type: 'copyBindings', from: 'cursor', to: ['vscode'] })

    expect(effectiveChord(next, 'file.save', 'vscode')?.origin).toBe('user')
  })

  it('plans nothing when the targets already agree', () => {
    const state = createTableState(
      storeWith({ 'file.save': { cursor: imported('cmd+s'), vscode: imported('cmd+s') } })
    )

    expect(plannedCopy(state, catalogue, 'cursor', ['vscode'])).toEqual([])
    expect(
      hasPendingChanges(run(state, { type: 'copyBindings', from: 'cursor', to: ['vscode'] }))
    ).toBe(false)
  })

  it('plans exactly the cells the copy then changes', () => {
    const state = createTableState(
      storeWith({
        'file.save': { cursor: imported('cmd+s'), vscode: imported('cmd+s') },
        'edit.comment-line': { cursor: imported('cmd+/') }
      })
    )

    const plan = plannedCopy(state, catalogue, 'cursor', ['vscode', 'webstorm'])

    expect(plan.map((copy) => `${copy.actionId}:${copy.app}`)).toEqual([
      'file.save:webstorm',
      'edit.comment-line:vscode',
      'edit.comment-line:webstorm'
    ])
    expect(
      pendingChanges(
        run(state, { type: 'copyBindings', from: 'cursor', to: ['vscode', 'webstorm'] }),
        catalogue
      )
    ).toHaveLength(plan.length)
  })

  it('copies what the user has pending, not what was last saved', () => {
    const state = createTableState(storeWith({ 'file.save': { cursor: imported('cmd+s') } }))

    const next = run(
      state,
      { type: 'setChord', actionId: 'file.save', app: 'cursor', chord: saveAll },
      { type: 'copyBindings', from: 'cursor', to: ['vscode'] }
    )

    expect(canonicalOf(next, 'file.save', 'vscode')).toBe('alt+cmd+s')
  })

  it('has nothing to do for a row that was just matched', () => {
    const state = run(createTableState(storeWith({ 'file.save': { cursor: imported('cmd+s') } })), {
      type: 'matchRow',
      actionId: 'file.save'
    })

    expect(plannedCopy(state, catalogue, 'cursor', ['vscode'])).toEqual([])
  })
})

describe('pending changes', () => {
  it('lists every edit since the last save, with previous and next values', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), cursor: imported('cmd+s') } })
    )

    const next = run(
      state,
      { type: 'setChord', actionId: 'file.save', app: 'cursor', chord: saveAll },
      { type: 'setChord', actionId: 'file.save', app: 'webstorm', chord: saveAll }
    )
    const changes = pendingChanges(next, catalogue)

    expect(hasPendingChanges(next)).toBe(true)
    expect(changes).toEqual([
      {
        actionId: 'file.save',
        actionName: 'Save',
        app: 'cursor',
        previous: imported('cmd+s'),
        next: { chord: 'alt+cmd+s', origin: 'user' }
      },
      {
        actionId: 'file.save',
        actionName: 'Save',
        app: 'webstorm',
        previous: undefined,
        next: { chord: 'alt+cmd+s', origin: 'user' }
      }
    ])
  })

  it('drops an edit that puts a cell back where it started', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+s', origin: 'user' } } })
    )

    const next = run(
      state,
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: saveAll },
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: save }
    )

    expect(hasPendingChanges(next)).toBe(false)
    expect(pendingChanges(next, catalogue)).toEqual([])
  })

  it('discards back to exactly the saved state', () => {
    const store = storeWith({ 'file.save': { vscode: imported('cmd+s') } })
    const state = createTableState(store)

    const next = run(
      state,
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: saveAll },
      { type: 'matchRow', actionId: 'file.save' },
      { type: 'discardPending' }
    )

    expect(next.store).toBe(store)
    expect(hasPendingChanges(next)).toBe(false)
    expect(next).toEqual(state)
  })

  it('folds pending into the store and empties it on markSaved', () => {
    const state = createTableState(storeWith({ 'file.save': { vscode: imported('cmd+s') } }))

    const next = run(
      state,
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: saveAll },
      { type: 'markSaved' }
    )

    expect(hasPendingChanges(next)).toBe(false)
    expect(next.store.chords['file.save'].vscode).toEqual({ chord: 'alt+cmd+s', origin: 'user' })
    // The pre-save state is untouched, so a failed write can keep its overlay.
    expect(state.store.chords['file.save'].vscode).toEqual(imported('cmd+s'))
  })
})

describe('import and app configuration', () => {
  it('applies imported bindings straight into the saved store', () => {
    const state = createTableState(createEmptyStore())

    const next = run(state, {
      type: 'importBindings',
      payload: {
        bindings: [
          { actionId: 'file.save', app: 'vscode', chord: save, origin: 'default' },
          {
            actionId: 'file.save',
            app: 'webstorm',
            chord: parseCanonical('ctrl+s')!,
            origin: 'imported'
          },
          { actionId: 'file.save', app: 'ghostty', chord: null, origin: 'default' }
        ],
        markFirstRunCompleted: true
      }
    })

    expect(next.store.chords['file.save']).toEqual({
      vscode: { chord: 'cmd+s', origin: 'default' },
      webstorm: { chord: 'ctrl+s', origin: 'imported' },
      ghostty: { chord: null, origin: 'default' }
    })
    expect(next.store.firstRunCompleted).toBe(true)
    expect(hasPendingChanges(next)).toBe(false)
  })

  it('never overwrites a chord the user set inside unikeys', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'alt+cmd+s', origin: 'user' } } })
    )

    const next = run(state, {
      type: 'importBindings',
      payload: {
        bindings: [{ actionId: 'file.save', app: 'vscode', chord: save, origin: 'default' }]
      }
    })

    expect(canonicalOf(next, 'file.save', 'vscode')).toBe('alt+cmd+s')
  })

  it('treats only a cell with no entry at all as unseen', () => {
    // The rule that keeps a backfill safe: it fills holes and nothing else.
    const store = storeWith({
      'file.save': {
        vscode: { chord: 'cmd+s', origin: 'default' },
        webstorm: { chord: null, origin: 'user' }
      }
    })

    expect(isCellUnseen(store, 'file.save', 'vscode')).toBe(false)
    // Deliberately unbound is a decision, not a hole.
    expect(isCellUnseen(store, 'file.save', 'webstorm')).toBe(false)
    expect(isCellUnseen(store, 'file.save', 'cursor')).toBe(true)
    // A row the catalogue gained after the last import.
    expect(isCellUnseen(store, 'pane.focus-up', 'vscode')).toBe(true)
  })

  it('records app enablement and a hand-set config path', () => {
    const state = createTableState(createEmptyStore())

    const next = run(
      state,
      { type: 'setAppEnabled', app: 'webstorm', enabled: false },
      { type: 'setAppConfigPath', app: 'ghostty', path: '/somewhere/config' }
    )

    expect(next.store.apps.webstorm).toEqual({ enabled: false, configPath: null, grants: {} })
    expect(next.store.apps.ghostty).toEqual({
      enabled: true,
      configPath: '/somewhere/config',
      grants: {}
    })
    expect(state.store.apps.webstorm.enabled).toBe(true)
  })

  it('adds a granted folder to the ones an app already holds', () => {
    // The reason grants are a collection: a config symlinked into a dotfiles
    // repo needs the standard location *and* the repo, and the second grant
    // replacing the first is what made that setup impossible to finish.
    const state = createTableState(createEmptyStore())

    const once = run(state, {
      type: 'grantApp',
      app: 'zed',
      directory: '/home/me/.config/zed',
      grant: 'bookmark-a'
    })
    const twice = run(once, {
      type: 'grantApp',
      app: 'zed',
      directory: '/home/me/dotfiles/zed',
      grant: 'bookmark-b'
    })

    expect(twice.store.apps.zed.grants).toEqual({
      '/home/me/.config/zed': 'bookmark-a',
      '/home/me/dotfiles/zed': 'bookmark-b'
    })
  })

  it('replaces the bookmark when the same folder is granted again', () => {
    // Keyed by directory so re-granting refreshes rather than accumulating —
    // otherwise every re-prompt would leave another dead bookmark behind.
    const state = createTableState(createEmptyStore())
    const grant = (grant: string): TableState =>
      run(state, { type: 'grantApp', app: 'zed', directory: '/same/folder', grant })

    expect(grant('fresh').store.apps.zed.grants).toEqual({ '/same/folder': 'fresh' })
  })

  it('toggles onboarding completion without touching anything else', () => {
    const state = run(createTableState(storeWith({ 'file.save': { vscode: imported('cmd+s') } })), {
      type: 'setChord',
      actionId: 'file.save',
      app: 'webstorm',
      chord: save
    })

    const done = run(state, { type: 'setOnboardingCompleted', completed: true })
    expect(done.store.onboardingCompleted).toBe(true)
    expect(done.pending).toEqual(state.pending)
    expect(done.store.chords).toEqual(state.store.chords)
    expect(done.store.apps).toEqual(state.store.apps)

    // Settings replays the wizard by un-completing, so the toggle must go both
    // ways.
    const replay = run(done, { type: 'setOnboardingCompleted', completed: false })
    expect(replay.store.onboardingCompleted).toBe(false)
    expect(state.store.onboardingCompleted).toBe(false)
  })
})
