import { describe, expect, it } from 'vitest'
import { APPS, type AppId } from './apps'
import type { AppHealth, AppStatus } from './ipc'
import { accessQueue } from './onboarding'

function status(app: AppId, health: AppHealth): AppStatus {
  return {
    app,
    name: APPS[app].name,
    health,
    installed: true,
    enabled: true,
    resolvedPath: null,
    overridePath: null,
    searchedPaths: [],
    problems: [],
    userBindingCount: 0,
    defaultsAvailability: 'complete',
    reloadHint: APPS[app].reloadHint
  }
}

const all = (apps: AppId[]): ReadonlySet<AppId> => new Set(apps)

describe('accessQueue', () => {
  it('queues every access-blocked health under the sandbox', () => {
    const statuses = [
      status('vscode', 'grant-required'),
      status('obsidian', 'config-path-required'),
      status('warp', 'config-not-found'),
      status('zed', 'ok'),
      status('ghostty', 'config-not-created'),
      status('cursor', 'disabled')
    ]
    const selected = all(['vscode', 'obsidian', 'warp', 'zed', 'ghostty', 'cursor'])

    expect(accessQueue(statuses, selected, true)).toEqual(['vscode', 'warp', 'obsidian'])
  })

  it('never asks for a grant in the dmg build', () => {
    // Grants do not exist outside the sandbox: a `grant-required` health could
    // only come from a store that travelled between builds, and prompting for
    // it would open a picker whose answer the dmg build cannot store.
    const statuses = [
      status('vscode', 'grant-required'),
      status('obsidian', 'config-path-required'),
      status('warp', 'config-not-found')
    ]
    const selected = all(['vscode', 'obsidian', 'warp'])

    expect(accessQueue(statuses, selected, false)).toEqual(['warp', 'obsidian'])
  })

  it('only queues apps the user selected', () => {
    const statuses = [status('vscode', 'grant-required'), status('cursor', 'grant-required')]

    expect(accessQueue(statuses, all(['cursor']), true)).toEqual(['cursor'])
  })

  it('orders the queue by APP_IDS, not by the statuses given', () => {
    // Same order as the table's columns, however the status list arrived.
    const statuses = [
      status('obsidian', 'config-path-required'),
      status('ghostty', 'grant-required'),
      status('vscode', 'grant-required')
    ]
    const selected = all(['obsidian', 'ghostty', 'vscode'])

    expect(accessQueue(statuses, selected, true)).toEqual(['vscode', 'ghostty', 'obsidian'])
  })

  it('returns nothing when every selected app is readable', () => {
    // The replay case: grants already in place mean the wizard skips straight
    // from picking to results.
    const statuses = [status('vscode', 'ok'), status('ghostty', 'ok')]

    expect(accessQueue(statuses, all(['vscode', 'ghostty']), true)).toEqual([])
    expect(accessQueue([], all(['vscode']), true)).toEqual([])
  })
})
