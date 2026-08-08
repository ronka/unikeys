import { describe, expect, it } from 'vitest'

import type { AppId } from '../apps'
import type { WriteResult } from '../ipc'
import type { PendingChange } from '../table/reducer'
import { savedCells } from '../table/save-outcome'
import { buildSaveEntry } from './entry'

function change(parts: Partial<PendingChange> = {}): PendingChange {
  return {
    actionId: 'file.save',
    actionName: 'Save',
    app: 'vscode',
    previous: { chord: 'cmd+s', origin: 'imported' },
    next: { chord: 'cmd+shift+s', origin: 'user' },
    ...parts
  }
}

function result(parts: Partial<WriteResult> = {}): WriteResult {
  return {
    written: [],
    failed: [],
    skipped: [],
    dropped: [],
    backupDirectory: '/tmp/backups',
    ...parts
  }
}

function wrote(app: AppId): WriteResult['written'][number] {
  return { app, name: app, path: `/tmp/${app}`, backupPath: null, reloadHint: '' }
}

const ok = (write: WriteResult) => ({ ok: true, result: write }) as const

describe('buildSaveEntry', () => {
  it('records what each cell was and became, with the outcome the write reported', () => {
    const entry = buildSaveEntry([change()], ok(result({ written: [wrote('vscode')] })))

    expect(entry).toMatchObject({
      kind: 'save',
      changes: [
        {
          actionId: 'file.save',
          actionName: 'Save',
          app: 'vscode',
          previous: { chord: 'cmd+s', origin: 'imported' },
          next: { chord: 'cmd+shift+s', origin: 'user' },
          outcome: 'written'
        }
      ]
    })
  })

  /**
   * The alignment the parallel-array version had to maintain by convention.
   * Each cell must get its own outcome even when they differ within one save.
   */
  it('gives every cell its own outcome', () => {
    const entry = buildSaveEntry(
      [
        change({ app: 'vscode' }),
        change({ app: 'cursor' }),
        change({ app: 'cmux', actionId: 'nav.go-to-file' })
      ],
      ok(
        result({
          written: [wrote('vscode')],
          failed: [{ app: 'cursor', name: 'Cursor', error: 'EACCES' }],
          dropped: [{ app: 'cmux', actionId: 'nav.go-to-file', reason: 'off', deliberate: true }]
        })
      )
    )

    expect(entry.changes.map((c) => [c.app, c.outcome])).toEqual([
      ['vscode', 'written'],
      ['cursor', 'failed'],
      ['cmux', 'settled']
    ])
  })

  /**
   * A cell unikeys had never seen has no value to put back, and the log has to
   * tell that apart from a deliberate unbinding — only the second is revertible.
   * JSON drops the undefined, so it reloads as absent rather than as null.
   */
  it('keeps an unseen cell distinguishable from a deliberately unbound one', () => {
    const entry = buildSaveEntry(
      [
        change({ app: 'vscode', previous: undefined }),
        change({ app: 'cursor', previous: { chord: null, origin: 'user' } })
      ],
      ok(result({ written: [wrote('vscode'), wrote('cursor')] }))
    )

    const [unseen, unbound] = entry.changes
    expect(unseen.previous).toBeUndefined()
    expect(unbound.previous).toEqual({ chord: null, origin: 'user' })
    expect(JSON.parse(JSON.stringify(entry)).changes[0]).not.toHaveProperty('previous')
  })

  it('records the apps that were written and the ones that were not', () => {
    const entry = buildSaveEntry(
      [change()],
      ok(
        result({
          written: [wrote('vscode')],
          failed: [{ app: 'cursor', name: 'Cursor', error: 'EACCES' }]
        })
      )
    )

    expect(entry.apps).toEqual([
      { app: 'vscode', name: 'vscode', ok: true },
      { app: 'cursor', name: 'Cursor', ok: false, error: 'EACCES' }
    ])
    expect(entry.error).toBeUndefined()
  })

  describe('a write that threw', () => {
    const entry = buildSaveEntry([change({ app: 'vscode' }), change({ app: 'cursor' })], {
      ok: false,
      error: 'spawn EPERM'
    })

    it('settles nothing, so the save stays revertible from nowhere', () => {
      expect(entry.changes.every((c) => c.outcome === 'failed')).toBe(true)
      expect(savedCells(entry.changes)).toEqual([])
    })

    it('claims nothing about any app, and says what went wrong', () => {
      expect(entry.apps).toEqual([])
      expect(entry.error).toBe('spawn EPERM')
    })
  })

  /**
   * The reason the classification lives in here: the cells the table folds away
   * are read off the same entry the log keeps, so the two cannot disagree.
   */
  it('agrees with the cells the table marks saved', () => {
    const entry = buildSaveEntry(
      [change({ app: 'vscode' }), change({ app: 'cursor' })],
      ok(
        result({
          written: [wrote('vscode')],
          failed: [{ app: 'cursor', name: 'Cursor', error: 'EACCES' }]
        })
      )
    )

    expect(savedCells(entry.changes)).toEqual([{ actionId: 'file.save', app: 'vscode' }])
  })
})
