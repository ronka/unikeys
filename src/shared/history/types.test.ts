import { describe, expect, it } from 'vitest'
import {
  appendEntry,
  canRevert,
  createEmptyHistory,
  deserializeHistory,
  revertibleChanges,
  serializeHistory,
  unrevertibleChanges,
  HISTORY_LIMIT,
  HISTORY_SCHEMA_VERSION,
  type HistoryChange,
  type HistoryEntry
} from './types'

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

function entry(parts: Partial<Extract<HistoryEntry, { kind: 'save' }>> = {}): HistoryEntry {
  return { kind: 'save', id: 'a', at: 1, changes: [change()], links: [], apps: [], ...parts }
}

describe('appendEntry', () => {
  it('puts the newest entry first', () => {
    const older = entry({ id: 'older' })
    const newer = entry({ id: 'newer' })
    expect(appendEntry([older], newer).map((e) => e.id)).toEqual(['newer', 'older'])
  })

  it('caps the log, dropping the oldest', () => {
    let entries: HistoryEntry[] = []
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      entries = appendEntry(entries, entry({ id: `e${i}` }))
    }
    expect(entries).toHaveLength(HISTORY_LIMIT)
    expect(entries[0].id).toBe(`e${HISTORY_LIMIT + 9}`)
    expect(entries.at(-1)?.id).toBe(`e10`)
  })
})

describe('what an entry can put back', () => {
  it('counts a cell with no previous value as unrevertible rather than reverting it', () => {
    const e = entry({ changes: [change({ previous: undefined })] })
    expect(revertibleChanges(e)).toEqual([])
    expect(unrevertibleChanges(e)).toHaveLength(1)
  })

  it('treats a previous of null as a value that can be restored', () => {
    const e = entry({ changes: [change({ previous: { chord: null, origin: 'user' } })] })
    expect(revertibleChanges(e)).toHaveLength(1)
  })

  it('ignores cells that never reached the store', () => {
    const e = entry({
      changes: [
        change({ app: 'vscode', outcome: 'failed' }),
        change({ app: 'cursor', outcome: 'unsupported' }),
        change({ app: 'ghostty', outcome: 'unreadable' }),
        change({ app: 'cmux', outcome: 'settled' })
      ]
    })
    expect(revertibleChanges(e).map((c) => c.app)).toEqual(['cmux'])
  })

  it('cannot revert an entry where every app failed', () => {
    expect(canRevert(entry({ changes: [change({ outcome: 'failed' })], error: 'boom' }))).toBe(
      false
    )
  })

  it('can revert a links-only entry', () => {
    const e: HistoryEntry = {
      kind: 'links-only',
      id: 'a',
      at: 1,
      links: [{ actionId: 'file.save', actionName: 'Save', linked: true }]
    }
    expect(canRevert(e)).toBe(true)
    expect(revertibleChanges(e)).toEqual([])
  })
})

describe('serialisation', () => {
  it('round-trips an entry', () => {
    const history = { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [entry()] }
    const outcome = deserializeHistory(serializeHistory(history))
    expect(outcome.ok && outcome.history.entries).toEqual(history.entries)
  })

  it('keeps an absent previous absent across the round trip', () => {
    const history = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [entry({ changes: [change({ previous: undefined })] })]
    }
    const outcome = deserializeHistory(serializeHistory(history))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const restored = outcome.history.entries[0]
    expect(restored.kind === 'save' && 'previous' in restored.changes[0]).toBe(false)
    expect(unrevertibleChanges(restored)).toHaveLength(1)
  })

  it('reads an empty log', () => {
    const outcome = deserializeHistory(serializeHistory(createEmptyHistory()))
    expect(outcome.ok && outcome.history.entries).toEqual([])
  })

  it('refuses a log from a newer unikeys', () => {
    const outcome = deserializeHistory(JSON.stringify({ schemaVersion: 99, entries: [] }))
    expect(outcome.ok).toBe(false)
  })

  it('refuses text that is not JSON', () => {
    expect(deserializeHistory('{oops').ok).toBe(false)
  })

  it('drops one malformed entry rather than the whole log', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      entries: [entry({ id: 'good' }), { kind: 'save', id: 'no-timestamp' }, null, 7]
    })
    const outcome = deserializeHistory(text)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.history.entries.map((e) => e.id)).toEqual(['good'])
  })

  it('reads an unrecognised outcome as failed, so it cannot invent a revert', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      entries: [entry({ changes: [change({ outcome: 'sideways' as never })] })]
    })
    const outcome = deserializeHistory(text)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(revertibleChanges(outcome.history.entries[0])).toEqual([])
  })

  it('caps a log that was longer on disk', () => {
    const entries = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => entry({ id: `e${i}` }))
    const outcome = deserializeHistory(JSON.stringify({ schemaVersion: 1, entries }))
    expect(outcome.ok && outcome.history.entries).toHaveLength(HISTORY_LIMIT)
  })
})
