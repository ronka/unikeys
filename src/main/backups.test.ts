/**
 * Where backups go, and — the point of these tests — where they never go.
 *
 * unikeys 1.0 (1.1.1) was rejected under App Store Review Guideline 2.4.5(i)
 * for copying the user's config files into its own container. The container is
 * `app.getPath('userData')` in the Mac App Store build, so the rule these tests
 * hold is one sentence: under sandbox, nothing unikeys copies of the user's
 * files may land under `userData`, whatever state the store is in.
 *
 * That rule is checkable without a signed build, which is why it is a test
 * rather than a line in a release checklist: `process.mas` is the real switch
 * the real build sets, and every path below is a real temp directory. What
 * cannot be checked here is macOS denying anything — there is no sandbox — so
 * these test unikeys' decisions, not their enforcement.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CATALOGUE } from '../shared/catalogue'
import { createEmptyStore, NO_GRANTS, type Store } from '../shared/store/types'
import { writeToApps } from './apps-service'
import { backupsDirectory, createBackupSession } from './config-files'
import { storeLocation } from './store-file'

function pretendSandboxed(): void {
  Object.defineProperty(process, 'mas', { value: true, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'mas', { value: undefined, configurable: true })
})

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `unikeys-${prefix}-`))
}

/** An action the shipped catalogue maps for Obsidian, whose config is a plain file. */
const ACTION_ID = 'navigate.goto-file'

/**
 * A store pointed at a vault, so a save has somewhere real to write.
 *
 * The vault is granted as well as named: under sandbox an app with no grant
 * never reaches the write at all, and a save that did not happen proves nothing
 * about where its backup went.
 */
function storePointedAtVault(vault: string): Store {
  const store = createEmptyStore()
  store.apps.obsidian.configPath = vault
  store.apps.obsidian.grants = { [vault]: 'bookmark' }
  return store
}

function vault(): string {
  const dir = join(temp('vault'), '.obsidian')
  mkdirSync(dir)
  writeFileSync(join(dir, 'hotkeys.json'), '{}\n')
  return dir
}

/** Every file anywhere under a directory, so "nothing was written" is provable. */
function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('choosing where backups go', () => {
  it('is the folder the user chose, under sandbox', () => {
    pretendSandboxed()
    const chosen = temp('chosen')
    expect(backupsDirectory({ directory: chosen, grants: NO_GRANTS }, temp('userdata'))).toBe(
      chosen
    )
  })

  it('is nowhere at all when they have not chosen one', () => {
    pretendSandboxed()
    // Not `userData`, which is the container. Nowhere — the save goes ahead
    // without a copy and the write report says so.
    expect(backupsDirectory({ directory: null, grants: NO_GRANTS }, temp('userdata'))).toBeNull()
  })

  it('sits beside unikeys’ own state outside the sandbox', () => {
    // The dmg build, where `userData` is an ordinary
    // `~/Library/Application Support/unikeys` that anyone can open. Nothing
    // about that build changed.
    const userData = temp('userdata')
    expect(backupsDirectory({ directory: null, grants: NO_GRANTS }, userData)).toBe(
      join(userData, 'backups')
    )
  })

  it('is not derivable from the store location any more', () => {
    // The field this used to come from is gone rather than merely unused: with
    // no `backupDirectory` on `StoreLocation` there is no value in the program
    // from which a container backup path can be reached by accident.
    expect(Object.keys(storeLocation(temp('userdata')))).toEqual(['storePath'])
  })
})

describe('a sandboxed save with no backups folder chosen', () => {
  it('writes the config and copies nothing into the container', () => {
    pretendSandboxed()
    const userData = temp('userdata')
    const store = storePointedAtVault(vault())

    const result = writeToApps(
      { bindings: [{ actionId: ACTION_ID, app: 'obsidian', chord: 'cmd+o' }] },
      store,
      CATALOGUE,
      createBackupSession(
        backupsDirectory(store.backups, userData),
        store.backups.grants,
        new Date(0)
      )
    )

    expect(result.written).toHaveLength(1)
    expect(result.written[0].backupPath).toBeNull()
    // What the write report shows the user: no folder, no copies, said out loud.
    expect(result.backupDirectory).toBeNull()
    expect(filesUnder(userData)).toEqual([])
  })

  it('copies nothing into the container for a store that predates the field either', () => {
    pretendSandboxed()
    const userData = temp('userdata')
    // A store written by 1.1.1 has no `backups` key at all. Deserialising fills
    // it in as "not chosen", and the sandboxed branch has no `userData`
    // fallback — so an upgrading user is asked, never quietly backed up into a
    // folder they cannot open.
    const store = storePointedAtVault(vault())

    writeToApps(
      { bindings: [{ actionId: ACTION_ID, app: 'obsidian', chord: 'cmd+o' }] },
      store,
      CATALOGUE,
      createBackupSession(
        backupsDirectory(createEmptyStore().backups, userData),
        NO_GRANTS,
        new Date(0)
      )
    )

    expect(filesUnder(userData)).toEqual([])
  })
})

describe('a sandboxed save with a folder chosen', () => {
  it('puts the copy in that folder, and still nothing in the container', () => {
    pretendSandboxed()
    const userData = temp('userdata')
    const chosen = temp('chosen')
    const store = storePointedAtVault(vault())
    store.backups = { directory: chosen, grants: { [chosen]: 'bookmark' } }

    const result = writeToApps(
      { bindings: [{ actionId: ACTION_ID, app: 'obsidian', chord: 'cmd+o' }] },
      store,
      CATALOGUE,
      createBackupSession(
        backupsDirectory(store.backups, userData),
        store.backups.grants,
        new Date(0)
      )
    )

    expect(result.backupDirectory).toBe(chosen)
    expect(result.written[0].backupPath).toContain(chosen)
    expect(filesUnder(chosen)).toHaveLength(1)
    expect(filesUnder(userData)).toEqual([])
  })

  it('backs a file up once per session, as before', () => {
    pretendSandboxed()
    const chosen = temp('chosen')
    const store = storePointedAtVault(vault())
    store.backups = { directory: chosen, grants: { [chosen]: 'bookmark' } }
    const session = createBackupSession(chosen, store.backups.grants, new Date(0))
    const request = {
      bindings: [{ actionId: ACTION_ID, app: 'obsidian' as const, chord: 'cmd+o' }]
    }

    const first = writeToApps(request, store, CATALOGUE, session)
    const second = writeToApps(request, store, CATALOGUE, session)

    expect(first.written[0].backupPath).toContain(chosen)
    // The session's first copy is the one holding the pre-unikeys state, so a
    // second save must not overwrite it with unikeys' own output.
    expect(second.written[0].backupPath).toBeNull()
    expect(filesUnder(chosen)).toHaveLength(1)
  })
})
