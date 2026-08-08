import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HISTORY_LIMIT, type HistoryEntry } from '../shared/history/types'
import { historyLocation, loadHistory, recordEntry } from './history-file'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unikeys-history-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entry(id: string): HistoryEntry {
  return {
    kind: 'save',
    id,
    at: 1,
    changes: [
      {
        actionId: 'file.save',
        actionName: 'Save',
        app: 'vscode',
        previous: { chord: 'cmd+s', origin: 'imported' },
        next: { chord: 'cmd+shift+s', origin: 'user' },
        outcome: 'written'
      }
    ],
    links: [],
    apps: [{ app: 'vscode', name: 'VS Code', ok: true }]
  }
}

describe('the history file', () => {
  it('reads as empty before anything has been saved', () => {
    expect(loadHistory(historyLocation(dir))).toEqual({ entries: [] })
  })

  it('writes an entry and reads it back', () => {
    const location = historyLocation(dir)
    recordEntry(location, [], entry('a'))

    expect(loadHistory(location).entries.map((e) => e.id)).toEqual(['a'])
    expect(JSON.parse(readFileSync(location.historyPath, 'utf8')).schemaVersion).toBe(1)
  })

  it('keeps the newest entries and caps the file', () => {
    const location = historyLocation(dir)
    let entries: HistoryEntry[] = []
    for (let i = 0; i < HISTORY_LIMIT + 3; i += 1) {
      entries = recordEntry(location, entries, entry(`e${i}`))
    }

    const reloaded = loadHistory(location).entries
    expect(reloaded).toHaveLength(HISTORY_LIMIT)
    expect(reloaded[0].id).toBe(`e${HISTORY_LIMIT + 2}`)
  })

  it('reports a damaged log and leaves the file alone rather than overwriting it', () => {
    const location = historyLocation(dir)
    writeFileSync(location.historyPath, '{ not json', 'utf8')

    const outcome = loadHistory(location)
    expect(outcome.entries).toEqual([])
    expect(outcome.error).toBeDefined()
    expect(readFileSync(location.historyPath, 'utf8')).toBe('{ not json')
  })
})
