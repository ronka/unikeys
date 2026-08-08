import { describe, expect, it } from 'vitest'
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
  canLinkWithoutWinner,
  createTableState,
  effectiveChord,
  effectiveLinked,
  hasPendingChanges,
  linkCandidates,
  pendingChanges,
  plannedCopy,
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

function storeWith(chords: Store['chords'], linkedActions: string[] = []): Store {
  return { ...createEmptyStore(), chords, linkedActions }
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
  it('touches only the edited cell in an unlinked row', () => {
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

  it('propagates to every mapped app in a linked row, and no unmapped app', () => {
    const state = createTableState(storeWith({}, ['edit.comment-line']))

    const next = run(state, {
      type: 'setChord',
      actionId: 'edit.comment-line',
      app: 'vscode',
      chord: chord(stroke('/', 'cmd'))
    })

    expect(canonicalOf(next, 'edit.comment-line', 'vscode')).toBe('cmd+/')
    expect(canonicalOf(next, 'edit.comment-line', 'cursor')).toBe('cmd+/')
    expect(canonicalOf(next, 'edit.comment-line', 'webstorm')).toBe('cmd+/')
    // Ghostty has no line-comment command, so a linked row must skip it.
    expect(canonicalOf(next, 'edit.comment-line', 'ghostty')).toBeUndefined()
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

  it('clears a cell to an explicit unbinding, propagating in a linked row', () => {
    const state = createTableState(
      storeWith(
        {
          'edit.comment-line': {
            vscode: imported('cmd+/'),
            cursor: imported('cmd+/'),
            webstorm: imported('cmd+/')
          }
        },
        ['edit.comment-line']
      )
    )

    const next = run(state, { type: 'clearChord', actionId: 'edit.comment-line', app: 'cursor' })

    for (const app of ['vscode', 'cursor', 'webstorm'] as const) {
      expect(effectiveChord(next, 'edit.comment-line', app)).toEqual({
        chord: null,
        origin: 'user'
      })
    }
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

describe('linking', () => {
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

    const candidates = linkCandidates(state, catalogue.actions[0])

    expect(candidates.map((candidate) => candidate.canonical)).toEqual(['cmd+s', 'ctrl+s'])
    expect(candidates[0].apps).toEqual(['vscode', 'cursor'])
    expect(candidates[1].apps).toEqual(['webstorm'])
    expect(canLinkWithoutWinner(state, catalogue.actions[0])).toBe(false)
  })

  it('refuses to pick a winner for a divergent row', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), webstorm: imported('ctrl+s') } })
    )

    const next = run(state, { type: 'linkRow', actionId: 'file.save' })

    expect(next).toBe(state)
    expect(effectiveLinked(next, 'file.save')).toBe(false)
  })

  it('applies the winning chord to every mapped app', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), webstorm: imported('ctrl+s') } })
    )

    const next = run(state, {
      type: 'linkRow',
      actionId: 'file.save',
      winningChord: parseCanonical('ctrl+s')!
    })

    expect(effectiveLinked(next, 'file.save')).toBe(true)
    for (const app of ['vscode', 'cursor', 'webstorm', 'ghostty'] as const) {
      expect(canonicalOf(next, 'file.save', app)).toBe('ctrl+s')
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

    expect(canLinkWithoutWinner(state, catalogue.actions[2])).toBe(true)

    const next = run(state, { type: 'linkRow', actionId: 'edit.comment-line' })

    expect(effectiveLinked(next, 'edit.comment-line')).toBe(true)
    // Nothing changed, so nothing is pending and the imported origins survive.
    expect(pendingChanges(next, catalogue)).toEqual([])
    expect(effectiveChord(next, 'edit.comment-line', 'vscode')).toEqual(imported('cmd+/'))
  })

  it('fills in mapped apps that had nothing when the rest agree', () => {
    const state = createTableState(storeWith({ 'file.save': { vscode: imported('cmd+s') } }))

    const next = run(state, { type: 'linkRow', actionId: 'file.save' })

    expect(canonicalOf(next, 'file.save', 'ghostty')).toBe('cmd+s')
    expect(effectiveChord(next, 'file.save', 'ghostty')?.origin).toBe('user')
  })

  it('accepts an explicit unbinding as the winner', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), webstorm: imported('ctrl+s') } })
    )

    const next = run(state, { type: 'linkRow', actionId: 'file.save', winningChord: null })

    for (const app of ['vscode', 'cursor', 'webstorm', 'ghostty'] as const) {
      expect(canonicalOf(next, 'file.save', app)).toBeNull()
    }
  })

  it('leaves every app on the last shared chord when unlinked', () => {
    // Each app starts somewhere different; linking settles them on cmd+s, a
    // later edit moves them all to alt+cmd+s, and unlinking must not revert.
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: imported('cmd+s'),
          cursor: imported('ctrl+s'),
          webstorm: imported('f2'),
          ghostty: imported('cmd+enter')
        }
      })
    )

    const next = run(
      state,
      { type: 'linkRow', actionId: 'file.save', winningChord: save },
      { type: 'setChord', actionId: 'file.save', app: 'webstorm', chord: saveAll },
      { type: 'unlinkRow', actionId: 'file.save' }
    )

    expect(effectiveLinked(next, 'file.save')).toBe(false)
    for (const app of ['vscode', 'cursor', 'webstorm', 'ghostty'] as const) {
      expect(canonicalOf(next, 'file.save', app)).toBe('alt+cmd+s')
    }
  })

  it('stops propagating once a row is unlinked', () => {
    const state = createTableState(storeWith({}, ['file.save']))

    const next = run(
      state,
      { type: 'unlinkRow', actionId: 'file.save' },
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: save }
    )

    expect(canonicalOf(next, 'file.save', 'vscode')).toBe('cmd+s')
    expect(canonicalOf(next, 'file.save', 'cursor')).toBeUndefined()
  })

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
      { type: 'linkRow', actionId: 'file.save' },
      { type: 'setChord', actionId: 'file.save', app: 'cursor', chord: saveAll },
      { type: 'markSaved' }
    ).store

    const hydrated = run(dirty, { type: 'hydrate', store: fromDisk })
    expect(hydrated.store).toBe(fromDisk)
    // The pending edit was made against a different store, so it is dropped
    // rather than silently reinterpreted against this one.
    expect(hasPendingChanges(hydrated)).toBe(false)
    expect(effectiveLinked(hydrated, 'file.save')).toBe(true)
    expect(canonicalOf(hydrated, 'file.save', 'vscode')).toBe('alt+cmd+s')
  })

  it('survives a store serialise/deserialise round trip', () => {
    const state = createTableState(createEmptyStore())
    const linked = run(
      state,
      { type: 'linkRow', actionId: 'file.save' },
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: save },
      { type: 'markSaved' }
    )

    const outcome = deserializeStore(serializeStore(linked.store))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const reloaded = createTableState(outcome.store)
    expect(effectiveLinked(reloaded, 'file.save')).toBe(true)
    expect(canonicalOf(reloaded, 'file.save', 'webstorm')).toBe('cmd+s')

    // And the row is still linked in behaviour, not just in the flag.
    const edited = run(reloaded, {
      type: 'setChord',
      actionId: 'file.save',
      app: 'ghostty',
      chord: saveAll
    })
    expect(canonicalOf(edited, 'file.save', 'vscode')).toBe('alt+cmd+s')
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

  it('has nothing to do for a linked row, whose apps already agree', () => {
    const state = createTableState(
      storeWith({ 'file.save': { cursor: imported('cmd+s'), vscode: imported('cmd+s') } }, [
        'file.save'
      ])
    )

    expect(plannedCopy(state, catalogue, 'cursor', ['vscode'])).toEqual([])
  })
})

describe('pending changes', () => {
  it('lists every edit since the last save, with previous and next values', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: imported('cmd+s'), cursor: imported('cmd+s') } }, [
        'file.save'
      ])
    )

    const next = run(state, {
      type: 'setChord',
      actionId: 'file.save',
      app: 'cursor',
      chord: saveAll
    })
    const changes = pendingChanges(next, catalogue)

    expect(hasPendingChanges(next)).toBe(true)
    expect(changes).toEqual([
      {
        actionId: 'file.save',
        actionName: 'Save',
        app: 'vscode',
        previous: imported('cmd+s'),
        next: { chord: 'alt+cmd+s', origin: 'user' }
      },
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
      },
      {
        actionId: 'file.save',
        actionName: 'Save',
        app: 'ghostty',
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
    const store = storeWith({ 'file.save': { vscode: imported('cmd+s') } }, ['edit.comment-line'])
    const state = createTableState(store)

    const next = run(
      state,
      { type: 'setChord', actionId: 'file.save', app: 'vscode', chord: saveAll },
      { type: 'linkRow', actionId: 'file.save' },
      { type: 'unlinkRow', actionId: 'edit.comment-line' },
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
      { type: 'linkRow', actionId: 'edit.comment-line' },
      { type: 'markSaved' }
    )

    expect(hasPendingChanges(next)).toBe(false)
    expect(next.store.chords['file.save'].vscode).toEqual({ chord: 'alt+cmd+s', origin: 'user' })
    expect(next.store.linkedActions).toEqual(['edit.comment-line'])
    // The pre-save state is untouched, so a failed write can keep its overlay.
    expect(state.store.chords['file.save'].vscode).toEqual(imported('cmd+s'))
  })

  it('records an unlink of a saved row as a pending change', () => {
    const state = createTableState(storeWith({}, ['file.save']))
    const next = run(state, { type: 'unlinkRow', actionId: 'file.save' })

    expect(hasPendingChanges(next)).toBe(true)
    expect(effectiveLinked(next, 'file.save')).toBe(false)

    const saved = run(next, { type: 'markSaved' })
    expect(saved.store.linkedActions).toEqual([])
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

    expect(next.store.apps.webstorm).toEqual({ enabled: false, configPath: null })
    expect(next.store.apps.ghostty).toEqual({ enabled: true, configPath: '/somewhere/config' })
    expect(state.store.apps.webstorm.enabled).toBe(true)
  })
})
