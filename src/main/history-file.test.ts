import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HISTORY_LIMIT,
  type HistoryEntry,
  type NewHistoryEntry,
  type SaveEntry
} from '../shared/history/types'
import { createHistoryLog, historyLocation, loadHistory, recordEntry } from './history-file'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unikeys-history-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entry(id: string): SaveEntry {
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

describe('an open log', () => {
  /** An entry as the renderer submits it: everything but the stamp. */
  function body(): NewHistoryEntry {
    const { changes, links, apps } = entry('ignored')
    return { kind: 'save', changes, links, apps }
  }

  it('stamps what the renderer submits rather than trusting it', () => {
    const log = createHistoryLog(dir)
    const [stamped] = log.append(body(), { id: 'stamped', at: 42 })

    expect(stamped).toMatchObject({ id: 'stamped', at: 42, kind: 'save' })
  })

  /**
   * A save can land before the History page has ever been opened. Starting from
   * an empty list there would overwrite every earlier record.
   */
  it('reads what is already on disk when the first append precedes any load', () => {
    recordEntry(historyLocation(dir), [], entry('earlier'))

    const log = createHistoryLog(dir)
    expect(log.append(body(), { id: 'later', at: 2 }).map((e) => e.id)).toEqual([
      'later',
      'earlier'
    ])
  })

  it('appends without re-reading, so a file changed underneath does not resurrect entries', () => {
    const log = createHistoryLog(dir)
    log.append(body(), { id: 'a', at: 1 })
    const entries = log.append(body(), { id: 'b', at: 2 })

    expect(entries.map((e) => e.id)).toEqual(['b', 'a'])
    expect(loadHistory(historyLocation(dir)).entries.map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('caps the log the same way however many appends arrive', () => {
    const log = createHistoryLog(dir)
    let entries: HistoryEntry[] = []
    for (let i = 0; i < HISTORY_LIMIT + 2; i += 1) {
      entries = log.append(body(), { id: `e${i}`, at: i })
    }

    expect(entries).toHaveLength(HISTORY_LIMIT)
    expect(entries[0].id).toBe(`e${HISTORY_LIMIT + 1}`)
  })

  /**
   * The entry crossed a process boundary to get here. Refusing it now means
   * someone can be told; writing it would mean it vanished at the next load.
   */
  it('refuses an entry it could not read back, and writes nothing', () => {
    const log = createHistoryLog(dir)
    const nonsense = { kind: 'save', changes: [], links: [], apps: [] } as NewHistoryEntry

    expect(() => log.append(nonsense, { id: 'a', at: 1 })).toThrow()
    expect(loadHistory(historyLocation(dir)).entries).toEqual([])
  })

  it('leaves the cache untouched when an append is refused', () => {
    const log = createHistoryLog(dir)
    log.append(body(), { id: 'good', at: 1 })

    expect(() =>
      log.append({ kind: 'save', changes: [], links: [], apps: [] }, { id: 'bad', at: 2 })
    ).toThrow()
    expect(log.append(body(), { id: 'next', at: 3 }).map((e) => e.id)).toEqual(['next', 'good'])
  })
})
