import { describe, expect, it } from 'vitest'
import type { Catalogue } from '../catalogue/types'
import { formatCanonical } from '../chord'
import { createEmptyStore, type Store } from '../store/types'
import {
  createTableState,
  effectiveChord,
  tableReducer,
  type TableAction,
  type TableState
} from '../table/reducer'
import { describeRevert, planRevert, type RevertPlan } from './revert'
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

const apply = (state: TableState, actions: TableAction[]): TableState =>
  actions.reduce((current, action) => tableReducer(current, action, catalogue), state)

function storeWith(chords: Store['chords']): Store {
  return { ...createEmptyStore(), chords }
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

function saveEntry(parts: Partial<HistoryEntry> = {}): HistoryEntry {
  return { kind: 'save', id: 'a', at: 1, changes: [change()], apps: [], ...parts }
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
    const plan = planRevert(saveEntry())

    expect(chordAt(apply(state, plan.actions), 'file.save', 'vscode')).toBe('cmd+s')
  })

  it('restores a deliberately unbound cell as unbound, not as absent', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+shift+s', origin: 'user' } } })
    )
    const entry = saveEntry({
      changes: [change({ previous: { chord: null, origin: 'user' } })]
    })
    const after = apply(state, planRevert(entry).actions)

    expect(effectiveChord(after, 'file.save', 'vscode')).toEqual({ chord: null, origin: 'user' })
  })

  it('leaves a cell unikeys had never seen alone, and counts it', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+shift+s', origin: 'user' } } })
    )
    const plan = planRevert(saveEntry({ changes: [change({ previous: undefined })] }))

    expect(plan.actions).toEqual([])
    expect(plan.unseen).toBe(1)
    expect(chordAt(apply(state, plan.actions), 'file.save', 'vscode')).toBe('cmd+shift+s')
  })

  it('counts an unparseable recorded chord instead of unbinding the cell', () => {
    const entry = saveEntry({
      changes: [change({ previous: { chord: 'not a chord at all', origin: 'user' } })]
    })
    const plan = planRevert(entry)

    expect(plan.actions).toEqual([])
    expect(plan.unparseable).toBe(1)
  })

  it('skips cells the save never settled', () => {
    const entry = saveEntry({
      changes: [
        change({ app: 'vscode', outcome: 'failed' }),
        change({ app: 'cursor', outcome: 'written', previous: { chord: 'ctrl+s', origin: 'user' } })
      ]
    })
    const plan = planRevert(entry)

    expect(plan.actions).toEqual([
      { type: 'setChord', actionId: 'file.save', app: 'cursor', chord: expect.anything() }
    ])
  })

  /**
   * The regression the old unlink-first, relink-last ordering existed for. An
   * edit now lands in the cell it names and nowhere else, so a row saved as one
   * chord and recorded cell by cell comes back cell by cell — no ordering, and
   * no row left holding whichever value happened to be restored last.
   */
  it('restores each cell of a matched row to its own value, not the last one', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: { chord: 'cmd+shift+s', origin: 'user' },
          cursor: { chord: 'cmd+shift+s', origin: 'user' },
          webstorm: { chord: 'cmd+shift+s', origin: 'user' }
        }
      })
    )
    const entry = saveEntry({
      changes: [
        change({ app: 'vscode', previous: { chord: 'cmd+s', origin: 'imported' } }),
        change({ app: 'cursor', previous: { chord: 'ctrl+s', origin: 'imported' } }),
        change({ app: 'webstorm', previous: { chord: 'alt+s', origin: 'imported' } })
      ]
    })

    const after = apply(state, planRevert(entry).actions)

    expect(chordAt(after, 'file.save', 'vscode')).toBe('cmd+s')
    expect(chordAt(after, 'file.save', 'cursor')).toBe('ctrl+s')
    expect(chordAt(after, 'file.save', 'webstorm')).toBe('alt+s')
  })

  it('plans nothing but cell edits', () => {
    const plan = planRevert(saveEntry())
    expect(plan.actions.every((action) => action.type === 'setChord')).toBe(true)
  })
})

describe('describeRevert', () => {
  const plan = (parts: Partial<RevertPlan> = {}): RevertPlan => ({
    actions: [],
    unseen: 0,
    unparseable: 0,
    ...parts
  })

  it('says nothing when the revert hit no limits', () => {
    expect(describeRevert(plan())).toEqual([])
  })

  it('agrees with itself on number', () => {
    expect(describeRevert(plan({ unseen: 1 }))[0]).toContain('1 binding had')
    expect(describeRevert(plan({ unseen: 1 }))[0]).toContain('it was left alone')
    expect(describeRevert(plan({ unseen: 3 }))[0]).toContain('3 bindings had')
    expect(describeRevert(plan({ unseen: 3 }))[0]).toContain('they were left alone')
  })

  it('reports every limit it hit, not just the first', () => {
    expect(describeRevert(plan({ unseen: 1, unparseable: 2 }))).toHaveLength(2)
  })
})

describe('the round trip', () => {
  it('a revert of a revert lands back where the first save left things', () => {
    const start = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'cmd+s', origin: 'imported' } } })
    )

    const reverted = apply(start, planRevert(saveEntry()).actions)
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
    const back = apply(reverted, planRevert(undoEntry).actions)
    expect(chordAt(back, 'file.save', 'vscode')).toBe('cmd+s')
  })

  it('produces canonical chords the store can hold', () => {
    const plan = planRevert(saveEntry())
    const action = plan.actions[0]

    expect(action.type).toBe('setChord')
    if (action.type !== 'setChord') return
    expect(formatCanonical(action.chord)).toBe('cmd+s')
  })
})
