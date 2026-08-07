import { describe, expect, it } from 'vitest'
import { chord, stroke } from '../chord'
import type { Catalogue } from '../catalogue/types'
import { createEmptyStore, type Store } from '../store/types'
import { createTableState, tableReducer, type TableAction, type TableState } from './reducer'
import { buildRowView, buildTableView, summarizeImport } from './view'

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
      id: 'nav.go-to-file',
      name: 'Go To File',
      category: 'navigation',
      commands: { vscode: 'workbench.action.quickOpen', cursor: 'workbench.action.quickOpen' }
    },
    {
      id: 'terminal.split-right',
      name: 'Split Pane Right',
      category: 'terminal',
      commands: { ghostty: 'new_split:right' }
    }
  ]
}

const actionsById = Object.fromEntries(catalogue.actions.map((action) => [action.id, action]))
/**
 * Every column. Spelled out rather than derived from `APP_IDS` so that adding
 * an app is a deliberate edit here — a derived list would quietly extend these
 * cases to a column none of them was written for.
 */
const ALL_APPS = ['vscode', 'cursor', 'webstorm', 'ghostty', 'cmux'] as const

function storeWith(chords: Store['chords'], linkedActions: string[] = []): Store {
  return { ...createEmptyStore(), chords, linkedActions }
}

function run(state: TableState, ...actions: TableAction[]): TableState {
  return actions.reduce((current, action) => tableReducer(current, action, catalogue), state)
}

describe('cell states', () => {
  it('tells a not-applicable cell apart from an unbound one', () => {
    const state = createTableState(
      storeWith({ 'terminal.split-right': { ghostty: { chord: null, origin: 'user' } } })
    )

    const row = buildRowView(state, actionsById['terminal.split-right'], ALL_APPS)

    expect(row.cells.ghostty).toEqual({ kind: 'unbound', pending: false })
    expect(row.cells.vscode).toEqual({ kind: 'not-applicable' })
    expect(row.cells.webstorm).toEqual({ kind: 'not-applicable' })
  })

  it('renders a bound cell with macOS symbols and its origin', () => {
    const state = createTableState(
      storeWith({ 'file.save': { vscode: { chord: 'shift+cmd+s', origin: 'default' } } })
    )

    const row = buildRowView(state, actionsById['file.save'], ALL_APPS)

    expect(row.cells.vscode).toEqual({
      kind: 'bound',
      chord: chord(stroke('s', 'shift', 'cmd')),
      display: '⇧⌘S',
      origin: 'default',
      pending: false
    })
  })

  it('flags a cell carrying an unsaved edit', () => {
    const state = run(createTableState(createEmptyStore()), {
      type: 'setChord',
      actionId: 'file.save',
      app: 'vscode',
      chord: chord(stroke('s', 'cmd'))
    })

    const row = buildRowView(state, actionsById['file.save'], ALL_APPS)

    expect(row.cells.vscode).toMatchObject({ kind: 'bound', display: '⌘S', pending: true })
    expect(row.cells.cursor).toEqual({ kind: 'unbound', pending: false })
    expect(row.hasPending).toBe(true)
  })
})

describe('divergence', () => {
  it('marks a row whose apps hold different chords', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: { chord: 'cmd+s', origin: 'imported' },
          cursor: { chord: 'cmd+s', origin: 'imported' },
          webstorm: { chord: 'ctrl+s', origin: 'imported' },
          ghostty: { chord: 'cmd+s', origin: 'imported' }
        }
      })
    )

    expect(buildRowView(state, actionsById['file.save'], ALL_APPS).divergent).toBe(true)
  })

  it('ignores not-applicable cells, so a terminal-only row never diverges', () => {
    const state = createTableState(
      storeWith({
        'terminal.split-right': { ghostty: { chord: 'shift+cmd+d', origin: 'default' } }
      })
    )

    expect(buildRowView(state, actionsById['terminal.split-right'], ALL_APPS).divergent).toBe(false)
  })

  it('ignores disabled apps', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: { chord: 'cmd+s', origin: 'imported' },
          cursor: { chord: 'cmd+s', origin: 'imported' },
          webstorm: { chord: 'ctrl+s', origin: 'imported' },
          ghostty: { chord: 'cmd+s', origin: 'imported' }
        }
      })
    )

    const visible = ['vscode', 'cursor', 'ghostty'] as const
    expect(buildRowView(state, actionsById['file.save'], visible).divergent).toBe(false)
  })

  it('counts a mapped app with nothing stored as disagreeing with a bound one', () => {
    const state = createTableState(
      storeWith({ 'nav.go-to-file': { vscode: { chord: 'cmd+p', origin: 'default' } } })
    )

    expect(buildRowView(state, actionsById['nav.go-to-file'], ALL_APPS).divergent).toBe(true)
  })

  it('does not diverge when a linked row has settled', () => {
    const state = run(
      createTableState(
        storeWith({
          'file.save': {
            vscode: { chord: 'cmd+s', origin: 'imported' },
            webstorm: { chord: 'ctrl+s', origin: 'imported' }
          }
        })
      ),
      { type: 'linkRow', actionId: 'file.save', winningChord: chord(stroke('s', 'cmd')) }
    )

    const row = buildRowView(state, actionsById['file.save'], ALL_APPS)
    expect(row.linked).toBe(true)
    expect(row.divergent).toBe(false)
  })
})

describe('the table view', () => {
  it('groups rows by category in the fixed catalogue order and drops empty groups', () => {
    const view = buildTableView(createTableState(createEmptyStore()), catalogue)

    expect(view.groups.map((group) => group.category)).toEqual([
      'editing',
      'navigation',
      'terminal'
    ])
    expect(view.groups.map((group) => group.label)).toEqual(['Editing', 'Navigation', 'Terminal'])
    expect(view.rowCount).toBe(3)
  })

  it('filters by a case-insensitive substring of the action name or id', () => {
    const state = createTableState(createEmptyStore())

    const byName = buildTableView(state, catalogue, { search: 'sPLit' })
    expect(byName.groups).toHaveLength(1)
    expect(byName.groups[0].rows.map((row) => row.action.id)).toEqual(['terminal.split-right'])

    const byId = buildTableView(state, catalogue, { search: 'nav.' })
    expect(byId.groups.map((group) => group.category)).toEqual(['navigation'])

    expect(buildTableView(state, catalogue, { search: 'zzz' }).groups).toEqual([])
  })

  it('shows only enabled apps as columns', () => {
    const state = run(createTableState(createEmptyStore()), {
      type: 'setAppEnabled',
      app: 'cursor',
      enabled: false
    })

    const view = buildTableView(state, catalogue)

    expect(view.apps).toEqual(['vscode', 'webstorm', 'ghostty', 'cmux'])
    expect(Object.keys(view.groups[0].rows[0].cells)).toEqual([
      'vscode',
      'webstorm',
      'ghostty',
      'cmux'
    ])
  })

  it('counts divergent rows across the whole table', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: { chord: 'cmd+s', origin: 'imported' },
          cursor: { chord: 'cmd+s', origin: 'imported' },
          webstorm: { chord: 'ctrl+s', origin: 'imported' },
          ghostty: { chord: 'cmd+s', origin: 'imported' }
        },
        'terminal.split-right': { ghostty: { chord: 'shift+cmd+d', origin: 'default' } }
      })
    )

    expect(buildTableView(state, catalogue).divergentCount).toBe(1)
  })
})

describe('the first-run import summary', () => {
  it('reports actions found, apps read and divergent rows', () => {
    const state = createTableState(
      storeWith({
        'file.save': {
          vscode: { chord: 'cmd+s', origin: 'default' },
          cursor: { chord: 'cmd+s', origin: 'default' },
          webstorm: { chord: 'ctrl+s', origin: 'imported' },
          ghostty: { chord: 'cmd+s', origin: 'default' }
        },
        'terminal.split-right': { ghostty: { chord: 'shift+cmd+d', origin: 'default' } }
      })
    )

    expect(summarizeImport(state, catalogue)).toEqual({
      actionsFound: 2,
      appsRead: ['vscode', 'cursor', 'webstorm', 'ghostty'],
      // Only Save disagrees; the terminal-only row is not applicable elsewhere.
      divergentRows: 1
    })
  })

  it('reports nothing found for an empty store', () => {
    expect(summarizeImport(createTableState(createEmptyStore()), catalogue)).toEqual({
      actionsFound: 0,
      appsRead: [],
      divergentRows: 0
    })
  })
})
