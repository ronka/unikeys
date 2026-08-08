/**
 * The upgrade regression and its fix.
 *
 * `createEmptyStore()` enables every `APP_ID`, so growing the table from six
 * apps to thirteen hands an existing user seven new switched-on columns for
 * apps they mostly do not have. `loadStore` seeds around that, and these pin
 * the rule in both directions: a new app the machine does not have arrives off,
 * and a choice the user has already made is never overwritten.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { APP_IDS, type AppId } from '../shared/apps'
import { serializeStore, createEmptyStore } from '../shared/store/types'
import { loadStore, saveStore, storeLocation, type StoreLocation } from './store-file'

function location(): StoreLocation {
  return storeLocation(mkdtempSync(join(tmpdir(), 'unikeys-store-')))
}

/** Pretends only these apps are on the machine. */
function installs(...apps: AppId[]): (app: AppId) => boolean {
  const present = new Set<AppId>(apps)
  return (app) => present.has(app)
}

/** A store as it was written when unikeys knew only six apps. */
const SIX_APP_DOCUMENT = JSON.stringify({
  schemaVersion: 1,
  apps: {
    vscode: { enabled: true, configPath: null },
    cursor: { enabled: false, configPath: null },
    webstorm: { enabled: true, configPath: null },
    ghostty: { enabled: true, configPath: null },
    cmux: { enabled: true, configPath: null },
    iterm2: { enabled: true, configPath: null }
  },
  chords: { 'edit.save': { vscode: { chord: 'cmd+s', origin: 'imported' } } },
  linkedActions: ['edit.save'],
  firstRunCompleted: true
})

describe('upgrading a six-app store', () => {
  const loc = (): StoreLocation => {
    const l = location()
    writeFileSync(l.storePath, SIX_APP_DOCUMENT)
    return l
  }

  it('arrives with the new apps off unless they are installed', () => {
    const { store } = loadStore(loc(), installs('zed', 'kiro'))

    expect(store.apps.zed.enabled).toBe(true)
    expect(store.apps.kiro.enabled).toBe(true)
    // Not installed, and the document had never heard of them.
    for (const app of ['antigravity', 'intellij', 'pycharm', 'warp', 'obsidian'] as const) {
      expect(store.apps[app].enabled, `${app} should have arrived off`).toBe(false)
    }
  })

  it('never overrides a choice the document already recorded', () => {
    // Cursor is off in the document and not installed; webstorm is on in the
    // document and not installed. Both keep what the document says.
    const { store } = loadStore(loc(), installs())

    expect(store.apps.cursor.enabled).toBe(false)
    expect(store.apps.webstorm.enabled).toBe(true)
    expect(store.apps.vscode.enabled).toBe(true)
  })

  it('leaves everything else about the store alone', () => {
    const { store } = loadStore(loc(), installs())

    expect(store.chords['edit.save'].vscode?.chord).toBe('cmd+s')
    expect(store.linkedActions).toEqual(['edit.save'])
    expect(store.firstRunCompleted).toBe(true)
  })

  it('is a one-time pass: the seeded store, once saved, is left alone next launch', () => {
    // The renderer persists the whole store whenever it changes, and a
    // persisted store lists all thirteen apps — so an app the user switches on
    // must not be switched back off on the next launch.
    const l = loc()
    const { store } = loadStore(l, installs())
    store.apps.zed.enabled = true
    saveStore(l, store)

    const { store: reloaded } = loadStore(l, installs())

    expect(reloaded.apps.zed.enabled).toBe(true)
  })
})

describe('a machine with no store yet', () => {
  it('starts with the apps the machine actually has', () => {
    const { store } = loadStore(location(), installs('vscode', 'ghostty'))

    expect(store.apps.vscode.enabled).toBe(true)
    expect(store.apps.ghostty.enabled).toBe(true)
    expect(store.apps.obsidian.enabled).toBe(false)
    expect(APP_IDS.filter((app) => store.apps[app].enabled)).toEqual(['vscode', 'ghostty'])
  })

  it('still reports a first run, so import and the summary still happen', () => {
    const { store } = loadStore(location(), installs('vscode'))
    expect(store.firstRunCompleted).toBe(false)
  })
})

describe('a store that cannot be read', () => {
  it('reports the problem and does not overwrite it', () => {
    const l = location()
    writeFileSync(l.storePath, '{ not json')

    const { store, error } = loadStore(l, installs('vscode'))

    expect(error).toBeTruthy()
    expect(store.apps.vscode.enabled).toBe(true)
    expect(store.apps.obsidian.enabled).toBe(false)
  })
})

describe('saveStore', () => {
  it('writes every app, so the next load treats none of them as new', () => {
    const l = location()
    saveStore(l, createEmptyStore())

    const written = JSON.parse(serializeStore(loadStore(l, installs()).store))

    expect(Object.keys(written.apps)).toEqual([...APP_IDS])
  })
})
