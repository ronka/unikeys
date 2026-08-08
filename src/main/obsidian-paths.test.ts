/**
 * Obsidian is the first app whose config has no standard location: its hotkeys
 * live at `<vault>/.obsidian/hotkeys.json` and unikeys has no way to guess the
 * vault. That makes the path handling behaviour rather than data, and it is the
 * one part of ticket 25 the pure adapter tests cannot reach — everything here
 * goes through the real `src/main` code against a real temp directory.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CATALOGUE } from '../shared/catalogue'
import { createEmptyStore } from '../shared/store/types'
import { appStatuses, writeToApps } from './apps-service'
import { createBackupSession, readConfig, writeTarget } from './config-files'

/** A throwaway vault, returning the `.obsidian` directory inside it. */
function vaultDotObsidian(): string {
  const root = mkdtempSync(join(tmpdir(), 'unikeys-obsidian-'))
  const dir = join(root, '.obsidian')
  mkdirSync(dir)
  return dir
}

function backups(): ReturnType<typeof createBackupSession> {
  return createBackupSession(mkdtempSync(join(tmpdir(), 'unikeys-backups-')), new Date(0))
}

/** An action the shipped catalogue maps for Obsidian. */
const ACTION_ID = 'navigate.goto-file'

describe('pointing unikeys at a vault', () => {
  it('resolves a .obsidian directory to the hotkeys.json inside it', () => {
    const dir = vaultDotObsidian()
    expect(writeTarget('obsidian', dir)).toEqual({ ok: true, path: join(dir, 'hotkeys.json') })
  })

  it('accepts the hotkeys.json itself', () => {
    const file = join(vaultDotObsidian(), 'hotkeys.json')
    expect(writeTarget('obsidian', file)).toEqual({ ok: true, path: file })
  })

  it('names the file it wants when the directory holds no hotkeys yet', () => {
    // Obsidian does not write hotkeys.json until the user sets a hotkey, so a
    // directory with nothing in it is the ordinary first state, not an error.
    const dir = vaultDotObsidian()
    expect(readConfig('obsidian', dir)).toEqual({
      ok: false,
      reason: 'not-found',
      searched: [join(dir, 'hotkeys.json')]
    })
  })

  it('reads through the directory once the file is there', () => {
    const dir = vaultDotObsidian()
    writeFileSync(join(dir, 'hotkeys.json'), '{}\n')
    expect(readConfig('obsidian', dir)).toEqual({
      ok: true,
      path: join(dir, 'hotkeys.json'),
      contents: '{}\n'
    })
  })
})

describe('with no vault configured', () => {
  it('reports config-path-required, naming what to point at', () => {
    const status = appStatuses(createEmptyStore().apps).find((s) => s.app === 'obsidian')
    expect(status?.health).toBe('config-path-required')
    expect(status?.message).toContain('hotkeys.json')
  })

  it('refuses to name a write target rather than inventing one', () => {
    const target = writeTarget('obsidian', null)
    expect(target.ok).toBe(false)
  })

  it('writes nowhere, and says so deliberately rather than staying pending', () => {
    const result = writeToApps(
      { bindings: [{ actionId: ACTION_ID, app: 'obsidian', chord: 'cmd+o' }] },
      createEmptyStore(),
      CATALOGUE,
      backups()
    )

    expect(result.written).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.dropped).toHaveLength(1)
    // Deliberate is what stops the edit sitting pending forever with nothing to
    // explain it.
    expect(result.dropped[0].deliberate).toBe(true)
  })
})

describe('with a vault configured', () => {
  it('reads the column from the vault', () => {
    const dir = vaultDotObsidian()
    writeFileSync(
      join(dir, 'hotkeys.json'),
      '{ "switcher:open": [{ "modifiers": ["Mod"], "key": "O" }] }\n'
    )
    const store = createEmptyStore()
    store.apps.obsidian.configPath = dir

    const status = appStatuses(store.apps).find((s) => s.app === 'obsidian')

    expect(status?.health).toBe('ok')
    expect(status?.resolvedPath).toBe(join(dir, 'hotkeys.json'))
    expect(status?.userBindingCount).toBe(1)
  })

  it('creates hotkeys.json inside the directory on the first save', () => {
    const dir = vaultDotObsidian()
    const store = createEmptyStore()
    store.apps.obsidian.configPath = dir

    const result = writeToApps(
      { bindings: [{ actionId: ACTION_ID, app: 'obsidian', chord: 'cmd+o' }] },
      store,
      CATALOGUE,
      backups()
    )

    expect(result.failed).toEqual([])
    expect(result.written.map((written) => written.path)).toEqual([join(dir, 'hotkeys.json')])
  })
})
