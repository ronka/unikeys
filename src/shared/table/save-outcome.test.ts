import { describe, expect, it } from 'vitest'
import type { AppId } from '../apps'
import type { WriteResult } from '../ipc'
import type { CellRef } from './reducer'
import { classifySaveOutcome, isSettled, savedCells, type SaveOutcome } from './save-outcome'

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

function cell(app: AppId, actionId = 'file.save'): CellRef {
  return { actionId, app }
}

/** The old predicate, kept verbatim as the oracle the refactor must match. */
function legacySavedCells(sent: readonly CellRef[], write: WriteResult): CellRef[] {
  const writtenApps = new Set(write.written.map((app) => app.app))
  const key = (ref: CellRef): string => `${ref.actionId}::${ref.app}`
  const settled = new Set(write.dropped.filter((drop) => drop.deliberate).map((drop) => key(drop)))
  const unexpressible = new Set(write.skipped.map((skip) => key(skip)))

  return sent.filter(
    (c) => (writtenApps.has(c.app) && !unexpressible.has(key(c))) || settled.has(key(c))
  )
}

function outcomeOf(sent: CellRef, write: WriteResult): SaveOutcome {
  return classifySaveOutcome([sent], write)[0].outcome
}

describe('classifySaveOutcome', () => {
  it('calls a cell on a written app written', () => {
    expect(outcomeOf(cell('vscode'), result({ written: [wrote('vscode')] }))).toBe('written')
  })

  it('calls a cell on a failed app failed', () => {
    const write = result({ failed: [{ app: 'vscode', name: 'VS Code', error: 'EACCES' }] })
    expect(outcomeOf(cell('vscode'), write)).toBe('failed')
  })

  it('calls an adapter-skipped chord unsupported even though its app was written', () => {
    const write = result({
      written: [wrote('ghostty')],
      skipped: [
        { app: 'ghostty', actionId: 'file.save', chord: 'cmd+k cmd+s', reason: 'no two-stroke' }
      ]
    })
    expect(outcomeOf(cell('ghostty'), write)).toBe('unsupported')
  })

  it('calls a deliberate drop settled', () => {
    const write = result({
      dropped: [{ app: 'cmux', actionId: 'file.save', reason: 'app is off', deliberate: true }]
    })
    expect(outcomeOf(cell('cmux'), write)).toBe('settled')
  })

  it('calls a non-deliberate drop unreadable even though its app was written', () => {
    const write = result({
      written: [wrote('vscode')],
      dropped: [
        { app: 'vscode', actionId: 'file.save', reason: 'unreadable chord', deliberate: false }
      ]
    })
    expect(outcomeOf(cell('vscode'), write)).toBe('unreadable')
  })

  it('prefers the cell-specific drop over its app failing', () => {
    const write = result({
      failed: [{ app: 'vscode', name: 'VS Code', error: 'EACCES' }],
      dropped: [{ app: 'vscode', actionId: 'file.save', reason: 'app is off', deliberate: true }]
    })
    expect(outcomeOf(cell('vscode'), write)).toBe('settled')
  })

  it('prefers the app failure over a per-chord skip', () => {
    const write = result({
      failed: [{ app: 'ghostty', name: 'Ghostty', error: 'EACCES' }],
      skipped: [{ app: 'ghostty', actionId: 'file.save', chord: 'cmd+k cmd+s', reason: 'nope' }]
    })
    expect(outcomeOf(cell('ghostty'), write)).toBe('failed')
  })

  it('is total: an app in neither list keeps its cell pending', () => {
    expect(outcomeOf(cell('iterm2'), result())).toBe('failed')
  })

  it('keys on both app and action, so one app cannot settle another row', () => {
    const write = result({
      written: [wrote('vscode')],
      skipped: [{ app: 'vscode', actionId: 'file.save', chord: 'cmd+s', reason: 'nope' }]
    })
    const outcomes = classifySaveOutcome([cell('vscode'), cell('vscode', 'nav.go-to-file')], write)
    expect(outcomes.map((o) => o.outcome)).toEqual(['unsupported', 'written'])
  })

  it('keys an action id containing the separator without colliding', () => {
    const odd = 'vscode:file.save'
    const write = result({
      written: [wrote('vscode')],
      skipped: [{ app: 'vscode', actionId: odd, chord: 'cmd+s', reason: 'nope' }]
    })
    const outcomes = classifySaveOutcome([cell('vscode', odd), cell('vscode', 'file.save')], write)
    expect(outcomes.map((o) => o.outcome)).toEqual(['unsupported', 'written'])
  })
})

describe('savedCells', () => {
  it('folds in written and settled cells only', () => {
    const write = result({
      written: [wrote('vscode')],
      failed: [{ app: 'ghostty', name: 'Ghostty', error: 'EACCES' }],
      skipped: [{ app: 'cursor', actionId: 'file.save', chord: 'cmd+s', reason: 'nope' }],
      dropped: [{ app: 'cmux', actionId: 'file.save', reason: 'app is off', deliberate: true }]
    })
    const sent = [cell('vscode'), cell('ghostty'), cell('cursor'), cell('cmux')]

    expect(savedCells(classifySaveOutcome(sent, write))).toEqual([
      { actionId: 'file.save', app: 'vscode' },
      { actionId: 'file.save', app: 'cmux' }
    ])
  })

  it('drops the extra fields a PendingChange-shaped cell carries', () => {
    const sent = [{ actionId: 'file.save', app: 'vscode' as AppId, chord: 'cmd+s' }]
    expect(savedCells(classifySaveOutcome(sent, result({ written: [wrote('vscode')] })))).toEqual([
      { actionId: 'file.save', app: 'vscode' }
    ])
  })
})

describe('agreement with the predicate this replaced', () => {
  const cursorSkip = { app: 'cursor' as AppId, actionId: 'file.save', chord: 'x', reason: 'nope' }
  const cases: Array<[string, WriteResult]> = [
    ['written, nothing else', result({ written: [wrote('cursor')] })],
    ['written and skipped', result({ written: [wrote('cursor')], skipped: [cursorSkip] })],
    [
      'written and deliberately dropped',
      result({
        written: [wrote('cursor')],
        dropped: [{ app: 'cursor', actionId: 'file.save', reason: 'off', deliberate: true }]
      })
    ],
    ['failed', result({ failed: [{ app: 'cursor', name: 'Cursor', error: 'EACCES' }] })],
    [
      'failed and skipped',
      result({ failed: [{ app: 'cursor', name: 'Cursor', error: 'E' }], skipped: [cursorSkip] })
    ],
    [
      'failed and deliberately dropped',
      result({
        failed: [{ app: 'cursor', name: 'Cursor', error: 'E' }],
        dropped: [{ app: 'cursor', actionId: 'file.save', reason: 'off', deliberate: true }]
      })
    ],
    [
      'absent and deliberately dropped',
      result({
        dropped: [{ app: 'cursor', actionId: 'file.save', reason: 'off', deliberate: true }]
      })
    ],
    [
      'absent and non-deliberately dropped',
      result({
        dropped: [{ app: 'cursor', actionId: 'file.save', reason: 'unreadable', deliberate: false }]
      })
    ]
  ]

  for (const [name, write] of cases) {
    it(`matches on: ${name}`, () => {
      const sent = [cell('cursor')]
      expect(savedCells(classifySaveOutcome(sent, write))).toEqual(legacySavedCells(sent, write))
    })
  }

  /**
   * The one deliberate divergence. The old predicate folded an unreadable chord
   * into the store whenever its app happened to write something else, losing the
   * cell — contrary to its own doc comment. It stays pending now.
   */
  it('diverges on a non-deliberate drop for an otherwise-written app, and keeps the cell', () => {
    const write = result({
      written: [wrote('cursor')],
      dropped: [{ app: 'cursor', actionId: 'file.save', reason: 'unreadable', deliberate: false }]
    })
    const sent = [cell('cursor')]

    expect(legacySavedCells(sent, write)).toEqual([{ actionId: 'file.save', app: 'cursor' }])
    expect(savedCells(classifySaveOutcome(sent, write))).toEqual([])
  })
})

describe('isSettled', () => {
  it('settles only written and settled', () => {
    const settled = (['written', 'settled', 'unsupported', 'unreadable', 'failed'] as const).filter(
      isSettled
    )
    expect(settled).toEqual(['written', 'settled'])
  })
})
