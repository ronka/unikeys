import { describe, expect, it } from 'vitest'
import type { Catalogue } from '../catalogue/types'
import { formatCanonical } from '../chord'
import { createEmptyStore, type Store } from '../store/types'
import {
  createTableState,
  effectiveChord,
  effectiveLinked,
  tableReducer,
  type TableAction,
  type TableState
} from '../table/reducer'
import { planRevert } from './revert'
import type { HistoryChange, HistoryEntry } from './types'

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
        webstorm: 'SaveDocument'
      }
    },
    {
      id: 'nav.go-to-file',
      name: 'Go To File',
      category: 'navigation',
      commands: { vscode: 'workbench.action.quickOpen', cursor: 'workbench.action.quickOpen' }
    }
  ]
}

const reduce = (state: TableState, action: TableAction): TableState =>
  tableReducer(state, action, catalogue)

const apply = (state: TableState, actions: TableAction[]): TableState =>
  actions.reduce(reduce, state)

function storeWith(chords: Store['chords'], linkedActions: string[] = []): Store {
  return { ...createEmptyStore(), chords, linkedActions }
}

function change(parts: Partial<HistoryChange> = {}): HistoryChange {
  return {
    actionId: 'file.save',
    actionName: 'Save',
    app: 'vscode',
    previous: { chord: 'cmd+s', origin: 'imported' },
    next: { chord: 'cmd+shift+s', origin: 'user' },
    outcome: 'written',
    ...parts
  }
}

function saveEntry(parts: Partial<Extract<HistoryEntry, { kind: 'save' }>> = {}): HistoryEntry {
  return { kind: 'save', id: 'a', at: 1, changes: [change()], links: [], apps: [], ...parts }
}

/** The canonical chord a cell effectively holds, for readable assertions. */
function chordAt(
  state: TableState,
  actionId: string,
  app: 'vscode' | 'cursor' | 'webstorm'
): string | null | undefined {
  return effectiveChord(state, actionId, app)?.chord
}

describe('planRevert', () => {
  it('puts a single cell back to its recorded previous chord', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+shift+s', origin: 'user' } } })
    )
    const plan = planRevert(saveEntry(), state, catalogue, reduce)

    expect(chordAt(apply(state, plan.actions), 'file.save', 'vscode')).toBe('cmd+s')
  })

  it('restores a deliberately unbound cell as unbound, not as absent', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+shift+s', origin: 'user' } } })
    )
    const entry = saveEntry({
      changes: [change({ previous: { chord: null, origin: 'user' } })]
    })
    const after = apply(state, planRevert(entry, state, catalogue, reduce).actions)

    expect(effectiveChord(after, 'file.save', 'vscode')).toEqual({ chord: null, origin: 'user' })
  })

  it('leaves a cell unikeys had never seen alone, and counts it', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+shift+s', origin: 'user' } } })
    )
    const plan = planRevert(
      saveEntry({ changes: [change({ previous: undefined })] }),
      state,
      catalogue,
      reduce
    )

    expect(plan.actions).toEqual([])
    expect(plan.unseen).toBe(1)
    expect(chordAt(apply(state, plan.actions), 'file.save', 'vscode')).toBe('cmd+shift+s')
  })

  it('counts an unparseable recorded chord instead of unbinding the cell', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+shift+s', origin: 'user' } } })
    )
    const entry = saveEntry({
      changes: [change({ previous: { chord: 'not a chord at all', origin: 'user' } })]
    })
    const plan = planRevert(entry, state, catalogue, reduce)

    expect(plan.actions).toEqual([])
    expect(plan.unparseable).toBe(1)
  })

  it('skips cells the save never settled', () => {
    const state = createTableState(storeWith({}))
    const entry = saveEntry({
      changes: [
        change({ app: 'vscode', outcome: 'failed' }),
        change({ app: 'cursor', outcome: 'written', previous: { chord: 'ctrl+s', origin: 'user' } })
      ]
    })
    const plan = planRevert(entry, state, catalogue, reduce)

    expect(plan.actions).toEqual([
      { type: 'setChord', actionId: 'file.save', app: 'cursor', chord: expect.anything() }
    ])
  })
})

describe('linked rows', () => {
  /**
   * The regression the unlink-first ordering exists for. While a row is linked,
   * `writeCell` propagates every edit across it, so restoring the cells one at a
   * time would leave the whole row holding the last one.
   */
  it('restores each cell of a linked row to its own value rather than the last one', () => {
    const state = createTableState(
      storeWith(
        {
          'file.save': {
            vscode: { chord: 'cmd+shift+s', origin: 'user' },
            cursor: { chord: 'cmd+shift+s', origin: 'user' },
            webstorm: { chord: 'cmd+shift+s', origin: 'user' }
          }
        },
        ['file.save']
      )
    )
    const entry = saveEntry({
      changes: [
        change({ app: 'vscode', previous: { chord: 'cmd+s', origin: 'imported' } }),
        change({ app: 'cursor', previous: { chord: 'ctrl+s', origin: 'imported' } }),
        change({ app: 'webstorm', previous: { chord: 'alt+s', origin: 'imported' } })
      ]
    })

    const after = apply(state, planRevert(entry, state, catalogue, reduce).actions)

    expect(chordAt(after, 'file.save', 'vscode')).toBe('cmd+s')
    expect(chordAt(after, 'file.save', 'cursor')).toBe('ctrl+s')
    expect(chordAt(after, 'file.save', 'webstorm')).toBe('alt+s')
  })

  it('unlinks before restoring, exactly once for the row', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'x', origin: 'user' } } }, ['file.save'])
    )
    const entry = saveEntry({
      changes: [
        change({ app: 'vscode', previous: { chord: 'cmd+s', origin: 'user' } }),
        change({ app: 'cursor', previous: { chord: 'ctrl+s', origin: 'user' } })
      ]
    })
    const plan = planRevert(entry, state, catalogue, reduce)

    expect(plan.actions.filter((a) => a.type === 'unlinkRow')).toEqual([
      { type: 'unlinkRow', actionId: 'file.save' }
    ])
    expect(plan.actions[0]).toEqual({ type: 'unlinkRow', actionId: 'file.save' })
  })

  it('undoes a link the save made, and restores the chords it propagated', () => {
    const state = createTableState(
      storeWith(
        {
          'file.save': {
            vscode: { chord: 'cmd+s', origin: 'user' },
            cursor: { chord: 'cmd+s', origin: 'user' }
          }
        },
        ['file.save']
      )
    )
    const entry = saveEntry({
      changes: [change({ app: 'cursor', previous: { chord: 'ctrl+s', origin: 'imported' } })],
      links: [{ actionId: 'file.save', actionName: 'Save', linked: true }]
    })

    const after = apply(state, planRevert(entry, state, catalogue, reduce).actions)

    expect(effectiveLinked(after, 'file.save')).toBe(false)
    expect(chordAt(after, 'file.save', 'cursor')).toBe('ctrl+s')
    expect(chordAt(after, 'file.save', 'vscode')).toBe('cmd+s')
  })

  it('re-links a row the save unlinked, once its chords agree again', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: { chord: 'cmd+s', origin: 'user' },
          cursor: { chord: 'cmd+s', origin: 'user' },
          webstorm: { chord: 'cmd+s', origin: 'user' }
        }
      })
    )
    const entry = saveEntry({
      changes: [],
      links: [{ actionId: 'file.save', actionName: 'Save', linked: false }]
    })

    const plan = planRevert(entry, state, catalogue, reduce)
    expect(plan.needsWinner).toEqual([])
    expect(effectiveLinked(apply(state, plan.actions), 'file.save')).toBe(true)
  })

  it('reports a row it cannot re-link rather than silently doing nothing', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: { chord: 'cmd+s', origin: 'user' },
          cursor: { chord: 'ctrl+s', origin: 'user' }
        }
      })
    )
    const entry = saveEntry({
      changes: [],
      links: [{ actionId: 'file.save', actionName: 'Save', linked: false }]
    })

    const plan = planRevert(entry, state, catalogue, reduce)

    expect(plan.needsWinner).toEqual(['Save'])
    expect(plan.actions).toEqual([])
  })

  /**
   * The guard has to judge the row as the revert will leave it. Here the cells
   * disagree right now but the restorations bring them back into agreement, so
   * re-linking is clean and must not be reported as needing a winner.
   */
  it('judges re-linking against the restored chords, not the current ones', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: { chord: 'cmd+s', origin: 'user' },
          cursor: { chord: 'ctrl+shift+s', origin: 'user' },
          webstorm: { chord: 'cmd+s', origin: 'user' }
        }
      })
    )
    const entry = saveEntry({
      changes: [change({ app: 'cursor', previous: { chord: 'cmd+s', origin: 'user' } })],
      links: [{ actionId: 'file.save', actionName: 'Save', linked: false }]
    })

    const plan = planRevert(entry, state, catalogue, reduce)

    expect(plan.needsWinner).toEqual([])
    expect(effectiveLinked(apply(state, plan.actions), 'file.save')).toBe(true)
  })

  it('reports an action the catalogue no longer carries', () => {
    const state = createTableState(storeWith({}))
    const entry = saveEntry({
      changes: [],
      links: [{ actionId: 'gone.away', actionName: 'Gone Away', linked: false }]
    })

    expect(planRevert(entry, state, catalogue, reduce).needsWinner).toEqual(['Gone Away'])
  })
})

describe('the round trip', () => {
  it('a revert of a revert lands back where the first save left things', () => {
    const start = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+s', origin: 'imported' } } })
    )
    const entry = saveEntry()

    const reverted = apply(start, planRevert(entry, start, catalogue, reduce).actions)
    expect(chordAt(reverted, 'file.save', 'vscode')).toBe('cmd+s')

    // What a save of that revert would record: previous and next swapped.
    const undoEntry = saveEntry({
      id: 'b',
      changes: [
        change({
          previous: { chord: 'cmd+s', origin: 'imported' },
          next: { chord: 'cmd+shift+s', origin: 'user' }
        })
      ]
    })
    const back = apply(reverted, planRevert(undoEntry, reverted, catalogue, reduce).actions)
    expect(chordAt(back, 'file.save', 'vscode')).toBe('cmd+s')
  })

  it('produces canonical chords the store can hold', () => {
    const state = createTableState(storeWith({}))
    const plan = planRevert(saveEntry(), state, catalogue, reduce)
    const action = plan.actions[0]

    expect(action.type).toBe('setChord')
    if (action.type !== 'setChord') return
    expect(formatCanonical(action.chord)).toBe('cmd+s')
  })
})
