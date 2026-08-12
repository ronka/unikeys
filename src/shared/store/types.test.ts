import { describe, expect, it } from 'vitest'
import { APP_IDS } from '../apps'
import { createEmptyStore, deserializeStore, serializeStore } from './types'

describe('createEmptyStore', () => {
  it('gives every app an entry', () => {
    const store = createEmptyStore()
    expect(Object.keys(store.apps)).toEqual([...APP_IDS])
  })
})

describe('deserializeStore', () => {
  /**
   * The upgrade path with no migration behind it. A store written when unikeys
   * knew six apps has to keep loading once it knows thirteen — the new columns
   * arrive from `createEmptyStore()`'s base, and the six the user already had
   * keep whatever they chose.
   */
  it('adds apps the document has never heard of, keeping the choices it has', () => {
    const older = JSON.stringify({
      schemaVersion: 1,
      apps: {
        vscode: { enabled: true, configPath: null },
        cursor: { enabled: false, configPath: null },
        webstorm: { enabled: true, configPath: '/somewhere/keymap.xml' },
        ghostty: { enabled: true, configPath: null },
        cmux: { enabled: true, configPath: null },
        iterm2: { enabled: true, configPath: null }
      },
      chords: { 'edit.save': { vscode: { chord: 'cmd+s', origin: 'imported' } } },
      linkedActions: ['edit.save'],
      firstRunCompleted: true
    })

    const outcome = deserializeStore(older)
    if (!outcome.ok) throw new Error(outcome.error)

    expect(Object.keys(outcome.store.apps)).toEqual([...APP_IDS])
    expect(outcome.store.apps.cursor.enabled).toBe(false)
    expect(outcome.store.apps.webstorm.configPath).toBe('/somewhere/keymap.xml')
    for (const app of APP_IDS) {
      expect(outcome.store.apps[app], `${app} has no config`).toBeDefined()
    }
    expect(outcome.store.chords['edit.save'].vscode?.chord).toBe('cmd+s')
    expect(outcome.store.firstRunCompleted).toBe(true)
  })

  it('round-trips a store it just wrote', () => {
    const outcome = deserializeStore(serializeStore(createEmptyStore()))
    if (!outcome.ok) throw new Error(outcome.error)
    expect(outcome.store).toEqual(createEmptyStore())
  })

  it('refuses a document from a newer schema rather than misreading it', () => {
    const outcome = deserializeStore(JSON.stringify({ schemaVersion: 99, apps: {} }))
    expect(outcome.ok).toBe(false)
  })

  describe('onboardingCompleted', () => {
    const read = (document: object): boolean => {
      const outcome = deserializeStore(JSON.stringify({ schemaVersion: 1, ...document }))
      if (!outcome.ok) throw new Error(outcome.error)
      return outcome.store.onboardingCompleted
    }

    it('starts false on a fresh store', () => {
      expect(createEmptyStore().onboardingCompleted).toBe(false)
    })

    it('treats a legacy store with a completed first run as already onboarded', () => {
      // The upgrade path: existing users must not be greeted by the wizard.
      expect(read({ firstRunCompleted: true })).toBe(true)
    })

    it('keeps an explicit false even though the first run completed', () => {
      // Quit mid-wizard: the every-launch import has already set
      // `firstRunCompleted`, and only the explicit key brings the wizard back.
      expect(read({ firstRunCompleted: true, onboardingCompleted: false })).toBe(false)
    })

    it('round-trips both values', () => {
      expect(read({ onboardingCompleted: true })).toBe(true)
      const store = { ...createEmptyStore(), onboardingCompleted: true }
      const outcome = deserializeStore(serializeStore(store))
      if (!outcome.ok) throw new Error(outcome.error)
      expect(outcome.store.onboardingCompleted).toBe(true)
    })
  })
})
