import { describe, expect, it } from 'vitest'
import { APP_IDS, type AppId } from '../apps'
import { CMUX_ACTION_IDS } from '../adapters/cmux'
import { ITERM2_ACTION_IDS } from '../adapters/iterm2-capture'
import { CATEGORIES, type CatalogueAction } from './types'
import { ACTIONS, CATALOGUE, actionById, actionsByCategory, loadCatalogue } from './index'
import catalogueData from './catalogue.json'

const mappedApps = (action: CatalogueAction): AppId[] =>
  APP_IDS.filter((app) => action.commands[app] !== undefined)

describe('the shipped catalogue', () => {
  it('validates cleanly', () => {
    expect(() => loadCatalogue(catalogueData)).not.toThrow()
    expect(CATALOGUE.version).toBe(1)
  })

  it('ships roughly forty actions', () => {
    expect(ACTIONS.length).toBeGreaterThanOrEqual(32)
    expect(ACTIONS.length).toBeLessThanOrEqual(42)
  })

  it('gives every action a unique id', () => {
    const ids = ACTIONS.map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers every category', () => {
    const seen = new Set(ACTIONS.map((action) => action.category))
    for (const category of CATEGORIES) {
      expect(seen.has(category)).toBe(true)
    }
  })

  it('maps every action to at least one app', () => {
    for (const action of ACTIONS) {
      expect(mappedApps(action).length, `${action.id} maps no app`).toBeGreaterThan(0)
    }
  })

  /**
   * A fork shares its parent's command ids, so a row that maps the parent and
   * disagrees with the fork is a typo rather than a decision. Checked in both
   * directions: a fork mapped where the parent is not would be just as wrong.
   */
  const FORK_FAMILIES: ReadonlyArray<{ parent: AppId; forks: readonly AppId[] }> = [
    { parent: 'vscode', forks: ['cursor', 'kiro', 'antigravity'] },
    { parent: 'webstorm', forks: ['intellij', 'pycharm'] }
  ]

  it('gives every fork the same command string as the app it forked', () => {
    for (const { parent, forks } of FORK_FAMILIES) {
      const mapped = ACTIONS.filter((action) => action.commands[parent] !== undefined)
      expect(mapped.length, `nothing maps ${parent}`).toBeGreaterThan(0)
      for (const action of ACTIONS) {
        for (const fork of forks) {
          expect(
            action.commands[fork],
            `${action.id} disagrees between ${parent} and ${fork}`
          ).toBe(action.commands[parent])
        }
      }
    }
  })

  it('includes a meaningful number of rows that reach most of the table', () => {
    // Not "every app": Zed, Warp and Obsidian map only what they really have,
    // and Obsidian in particular maps a handful of rows on purpose. What the
    // catalogue has to keep is rows broad enough to be worth linking.
    const broad = ACTIONS.filter((action) => mappedApps(action).length >= APP_IDS.length / 2)
    expect(broad.length).toBeGreaterThanOrEqual(6)
  })

  it('includes rows that deliberately skip apps with no equivalent', () => {
    const partial = ACTIONS.filter((action) => mappedApps(action).length < APP_IDS.length)
    expect(partial.length).toBeGreaterThan(0)
    // Ghostty is a terminal: editor-only actions must not invent a mapping.
    expect(actionById('edit.rename-symbol')?.commands.ghostty).toBeUndefined()
  })

  it('only maps cmux action ids cmux itself accepts', () => {
    // cmux's `shortcuts.bindings` is `additionalProperties: false`, so an id
    // outside its enum would make cmux reject the whole file on save.
    for (const action of ACTIONS) {
      const command = action.commands.cmux
      if (command === undefined) continue
      expect(CMUX_ACTION_IDS.has(command), `${action.id} maps unknown cmux id "${command}"`).toBe(
        true
      )
    }
  })

  it('only maps iTerm2 tokens the adapter knows', () => {
    // iTerm2 has no textual command names, so these tokens are unikeys' own
    // invention and only mean anything if the adapter can resolve them to an
    // (Action, Text) pair. A typo here would write a binding that does nothing.
    for (const action of ACTIONS) {
      const command = action.commands.iterm2
      if (command === undefined) continue
      expect(
        ITERM2_ACTION_IDS.has(command),
        `${action.id} maps unknown iTerm2 token "${command}"`
      ).toBe(true)
    }
  })

  it('marks shipped actions as builtin', () => {
    for (const action of ACTIONS) {
      expect(action.origin).toBe('builtin')
    }
  })
})

describe('actionById', () => {
  it('finds a shipped action', () => {
    const action = actionById('pane.split-right')
    expect(action?.name).toBe('Split Pane Right')
    expect(action?.commands.ghostty).toBe('new_split:right')
  })

  it('returns undefined for an unknown id', () => {
    expect(actionById('nope.not-real')).toBeUndefined()
  })
})

describe('actionsByCategory', () => {
  it('groups in CATEGORIES order and loses no action', () => {
    const groups = actionsByCategory()
    const order = groups.map((group) => group.category)
    expect(order).toEqual(CATEGORIES.filter((category) => order.includes(category)))
    expect(groups.flatMap((group) => group.actions).length).toBe(ACTIONS.length)
    for (const group of groups) {
      expect(group.actions.length).toBeGreaterThan(0)
      for (const action of group.actions) {
        expect(action.category).toBe(group.category)
      }
    }
  })
})

describe('loadCatalogue on malformed data', () => {
  const malformed = {
    version: 1,
    actions: [
      { id: 'edit.save', name: 'Save', category: 'editing', commands: { vscode: 'a' } },
      { id: 'edit.save', name: 'Save Again', category: 'editing', commands: { vscode: 'b' } },
      {
        id: 'edit.unknown-app',
        name: 'Unknown App',
        category: 'editing',
        commands: { emacs: 'x' }
      },
      {
        id: 'edit.bad-category',
        name: 'Bad Category',
        category: 'wizardry',
        commands: { vscode: 'x' }
      },
      {
        id: 'edit.empty-command',
        name: 'Empty Command',
        category: 'editing',
        commands: { vscode: '  ' }
      },
      { id: 'edit.no-name', category: 'editing', commands: { vscode: 'x' } }
    ]
  }

  it('throws naming every problem at once', () => {
    let message = ''
    expect(() => {
      try {
        loadCatalogue(malformed)
      } catch (error) {
        message = (error as Error).message
        throw error
      }
    }).toThrow(/Invalid action catalogue/)

    expect(message).toContain('duplicates action id "edit.save"')
    expect(message).toContain('unknown app "emacs"')
    expect(message).toContain('unknown category "wizardry"')
    expect(message).toContain('empty command')
    expect(message).toContain('missing a display name')
  })

  it('rejects data that is not a catalogue at all', () => {
    expect(() => loadCatalogue(null)).toThrow(/Invalid action catalogue/)
    expect(() => loadCatalogue({ version: 1 })).toThrow(/actions/)
    expect(() =>
      loadCatalogue({
        version: 1,
        actions: [{ id: 'Bad_Id', name: 'x', category: 'editing', commands: { vscode: 'x' } }]
      })
    ).toThrow(/invalid id/)
  })

  it('rejects an action that maps no app', () => {
    expect(() =>
      loadCatalogue({
        version: 1,
        actions: [{ id: 'edit.orphan', name: 'Orphan', category: 'editing', commands: {} }]
      })
    ).toThrow(/maps to no app/)
  })
})

describe('user-authored actions', () => {
  it('accepts an entry with origin "user" without a schema change', () => {
    const catalogue = loadCatalogue({
      version: 1,
      actions: [
        {
          id: 'custom.toggle-thing',
          name: 'Toggle My Thing',
          category: 'window',
          commands: { vscode: 'my.extension.toggleThing', ghostty: 'toggle_quick_terminal' },
          origin: 'user'
        }
      ]
    })
    expect(catalogue.actions[0].origin).toBe('user')
  })

  it('still rejects an unknown origin', () => {
    expect(() =>
      loadCatalogue({
        version: 1,
        actions: [
          {
            id: 'custom.thing',
            name: 'Thing',
            category: 'window',
            commands: { vscode: 'x' },
            origin: 'vendor'
          }
        ]
      })
    ).toThrow(/unknown origin/)
  })
})
