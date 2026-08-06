import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, parseCanonical, stroke } from '../chord'
import type { ManagedBinding } from './types'
import { vscodeAdapter } from './vscode'

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/vscode/${name}`, import.meta.url), 'utf8')
}

/** Merges and fails loudly, so every merge assertion reads as one expression. */
function mergedContents(contents: string, managed: ManagedBinding[]): string {
  const outcome = vscodeAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`merge failed: ${outcome.error}`)
  return outcome.contents
}

function encoded(text: string): string {
  const parsed = parseCanonical(text)
  if (parsed === null) throw new Error(`bad test chord: ${text}`)
  const outcome = vscodeAdapter.encodeChord(parsed)
  if (!outcome.ok) throw new Error(`could not encode ${text}: ${outcome.reason}`)
  return outcome.value
}

describe('identity', () => {
  it('serves VSCode and Cursor from one format', () => {
    expect(vscodeAdapter.format).toBe('vscode-keybindings')
    expect(vscodeAdapter.apps).toEqual(['vscode', 'cursor'])
  })
})

describe('encodeChord', () => {
  it('writes modifiers in the order VSCode configs conventionally use', () => {
    expect(encoded('cmd+shift+p')).toBe('cmd+shift+p')
    expect(encoded('shift+cmd+p')).toBe('cmd+shift+p')
    expect(encoded('alt+cmd+s')).toBe('cmd+alt+s')
    expect(encoded('ctrl+cmd+alt+shift+k')).toBe('ctrl+cmd+alt+shift+k')
  })

  it('writes named keys, punctuation and function keys literally', () => {
    expect(encoded('escape')).toBe('escape')
    expect(encoded('cmd+enter')).toBe('cmd+enter')
    expect(encoded('ctrl+`')).toBe('ctrl+`')
    expect(encoded('cmd+/')).toBe('cmd+/')
    expect(encoded('cmd+[')).toBe('cmd+[')
    expect(encoded('cmd+-')).toBe('cmd+-')
    expect(encoded('shift+f12')).toBe('shift+f12')
    expect(encoded('cmd+pagedown')).toBe('cmd+pagedown')
  })

  it('joins two keystrokes with a space', () => {
    expect(encoded('cmd+k cmd+s')).toBe('cmd+k cmd+s')
    expect(encoded('cmd+k z')).toBe('cmd+k z')
  })

  it('reports chords VSCode cannot express instead of guessing', () => {
    expect(vscodeAdapter.encodeChord({ strokes: [] })).toEqual({
      ok: false,
      reason: expect.stringContaining('no keystrokes')
    })

    const threeStrokes = chord(stroke('a'), stroke('b'), stroke('c'))
    expect(vscodeAdapter.encodeChord(threeStrokes).ok).toBe(false)

    // f20 exists in the canonical vocabulary but not in VSCode.
    expect(vscodeAdapter.encodeChord(chord(stroke('f20')))).toEqual({
      ok: false,
      reason: expect.stringContaining('f20')
    })

    expect(vscodeAdapter.encodeChord({ strokes: [{ modifiers: [], key: 'eject' }] }).ok).toBe(false)
  })
})

describe('decodeChord', () => {
  it('reads VSCode notation into canonical order', () => {
    expect(formatCanonical(vscodeAdapter.decodeChord('cmd+shift+p')!)).toBe('shift+cmd+p')
    expect(formatCanonical(vscodeAdapter.decodeChord('shift+cmd+p')!)).toBe('shift+cmd+p')
    expect(formatCanonical(vscodeAdapter.decodeChord('alt+cmd+down')!)).toBe('alt+cmd+down')
  })

  it('accepts meta and win as aliases for cmd', () => {
    expect(formatCanonical(vscodeAdapter.decodeChord('meta+s')!)).toBe('cmd+s')
    expect(formatCanonical(vscodeAdapter.decodeChord('win+s')!)).toBe('cmd+s')
  })

  it('reads two-keystroke chords', () => {
    expect(formatCanonical(vscodeAdapter.decodeChord('cmd+k cmd+s')!)).toBe('cmd+k cmd+s')
    expect(formatCanonical(vscodeAdapter.decodeChord('cmd+k z')!)).toBe('cmd+k z')
  })

  it('keeps punctuation base keys rather than treating them as separators', () => {
    expect(formatCanonical(vscodeAdapter.decodeChord('cmd+-')!)).toBe('cmd+-')
    expect(formatCanonical(vscodeAdapter.decodeChord('cmd+/')!)).toBe('cmd+/')
    expect(formatCanonical(vscodeAdapter.decodeChord('ctrl+`')!)).toBe('ctrl+`')
    expect(formatCanonical(vscodeAdapter.decodeChord('cmd+\\')!)).toBe('cmd+\\')
  })

  it('is case-insensitive about key names', () => {
    expect(formatCanonical(vscodeAdapter.decodeChord('Cmd+Shift+P')!)).toBe('shift+cmd+p')
  })

  it('returns null for notation it cannot represent', () => {
    expect(vscodeAdapter.decodeChord('')).toBeNull()
    expect(vscodeAdapter.decodeChord('cmd+')).toBeNull()
    expect(vscodeAdapter.decodeChord('cmd+numpad_multiply')).toBeNull()
    expect(vscodeAdapter.decodeChord('[KeyA]')).toBeNull()
    expect(vscodeAdapter.decodeChord('cmd+a cmd+b cmd+c')).toBeNull()
    expect(vscodeAdapter.decodeChord('a+cmd')).toBeNull()
  })

  it('round-trips every chord it decodes', () => {
    for (const text of ['cmd+shift+p', 'ctrl+g', 'cmd+k cmd+s', 'f8', 'cmd+alt+down', 'cmd+,']) {
      const decodedChord = vscodeAdapter.decodeChord(text)!
      const outcome = vscodeAdapter.encodeChord(decodedChord)
      expect(outcome).toEqual({ ok: true, value: text })
    }
  })
})

describe('parse', () => {
  it('reads a real-shaped user config', () => {
    const outcome = vscodeAdapter.parse(fixture('basic.json'))
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.problems).toEqual([])
    expect(outcome.bindings.map((b) => b.command)).toEqual([
      'workbench.action.showCommands',
      'workbench.action.openGlobalKeybindings',
      'workbench.action.toggleZenMode',
      'workbench.action.findInFiles',
      'editor.action.commentLine',
      'editor.action.insertCursorBelow'
    ])
    expect(outcome.bindings.every((b) => b.source === 'user')).toBe(true)
    expect(formatCanonical(outcome.bindings[1].chord!)).toBe('cmd+k cmd+s')
  })

  it('reads a -command entry as a negation of the bare command', () => {
    const outcome = vscodeAdapter.parse(fixture('basic.json'))
    if (!outcome.ok) throw new Error(outcome.error)

    const zen = outcome.bindings.find((b) => b.command === 'workbench.action.toggleZenMode')!
    expect(zen.negated).toBe(true)
    expect(zen.command).toBe('workbench.action.toggleZenMode')
    expect(formatCanonical(zen.chord!)).toBe('cmd+k z')

    // Nothing else is mistaken for a negation.
    const others = outcome.bindings.filter((b) => b.command !== 'workbench.action.toggleZenMode')
    expect(others.every((b) => b.negated === undefined)).toBe(true)
  })

  it('is not fooled by comment and comma characters inside strings', () => {
    const outcome = vscodeAdapter.parse(fixture('tricky-strings.json'))
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.bindings.map((b) => b.command)).toEqual([
      'editor.action.commentLine',
      'workbench.action.openSettings'
    ])
  })

  it('reports a bad entry as a problem rather than failing the file', () => {
    const outcome = vscodeAdapter.parse(fixture('tricky-strings.json'))
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.problems).toHaveLength(2)
    expect(outcome.problems[0].message).toContain('numpad_multiply')
    expect(outcome.problems[0].detail).toContain('workbench.action.terminal.new')
    expect(outcome.problems[1].message).toContain('no key')
  })

  it('treats an empty array, an empty file and a comment-only file as no bindings', () => {
    for (const contents of [fixture('empty-array.json'), '', '   \n\n', '// nothing here\n']) {
      expect(vscodeAdapter.parse(contents)).toEqual({ ok: true, bindings: [], problems: [] })
    }
  })

  it('fails the whole file for malformed JSON', () => {
    const outcome = vscodeAdapter.parse(fixture('malformed.json'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('not valid JSON')
  })

  it('fails when the root is not an array', () => {
    const outcome = vscodeAdapter.parse('{ "key": "cmd+s" }')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('array')
  })
})

describe('merge', () => {
  it('returns byte-identical contents when nothing changes', () => {
    const contents = fixture('basic.json')
    const managed: ManagedBinding[] = [
      { command: 'workbench.action.showCommands', chord: parseCanonical('shift+cmd+a') },
      { command: 'workbench.action.openGlobalKeybindings', chord: parseCanonical('cmd+k cmd+s') },
      { command: 'workbench.action.toggleZenMode', chord: null }
    ]
    expect(mergedContents(contents, managed)).toBe(contents)
  })

  it('returns byte-identical contents when nothing is managed', () => {
    const contents = fixture('basic.json')
    expect(mergedContents(contents, [])).toBe(contents)
  })

  it('is idempotent — merging its own output changes nothing further', () => {
    const managed: ManagedBinding[] = [
      { command: 'workbench.action.quickOpen', chord: parseCanonical('shift+cmd+o') },
      { command: 'editor.action.commentLine', chord: parseCanonical('ctrl+shift+7') },
      { command: 'workbench.action.gotoLine', chord: null }
    ]
    const once = mergedContents(fixture('basic.json'), managed)
    expect(mergedContents(once, managed)).toBe(once)
  })

  it('rewrites an existing entry in place, keeping its when clause and formatting', () => {
    const out = mergedContents(fixture('basic.json'), [
      { command: 'editor.action.commentLine', chord: parseCanonical('ctrl+shift+7') }
    ])

    expect(out).toContain(
      [
        '  {',
        '    "key": "ctrl+shift+7",',
        '    "command": "editor.action.commentLine",',
        '    "when": "editorTextFocus && !editorReadonly"',
        '  },'
      ].join('\n')
    )
    // The rest of the file is untouched, comments and trailing comma included.
    expect(out).toContain('// Place your key bindings in this file to override the defaults')
    expect(out).toContain('/* Save All is fine as shipped')
    expect(out).toContain('// Command palette, moved off the default so it matches WebStorm.')
    expect(out).toContain('"key": "cmd+shift+a",')
    expect(out.split('"command"')).toHaveLength(fixture('basic.json').split('"command"').length)
  })

  it('leaves unmanaged entries byte-for-byte alone', () => {
    const before = fixture('basic.json')
    const after = mergedContents(before, [
      { command: 'editor.action.commentLine', chord: parseCanonical('ctrl+shift+7') }
    ])

    const untouched = (text: string): string[] =>
      text.split('\n').filter((line) => !line.includes('cmd+/') && !line.includes('ctrl+shift+7'))
    expect(untouched(after)).toEqual(untouched(before))
  })

  it('appends a new entry in the file’s own indentation style', () => {
    const out = mergedContents(fixture('basic.json'), [
      { command: 'workbench.action.files.saveAll', chord: parseCanonical('alt+cmd+s') }
    ])

    expect(out.endsWith('\n')).toBe(true)
    expect(out).toContain(
      [
        '  {',
        '    "key": "cmd+alt+s",',
        '    "command": "workbench.action.files.saveAll"',
        '  }'
      ].join('\n')
    )
    // Appended, not inserted: the last pre-existing entry still precedes it.
    expect(out.indexOf('editor.action.insertCursorBelow')).toBeLessThan(
      out.indexOf('workbench.action.files.saveAll')
    )

    const reparsed = vscodeAdapter.parse(out)
    if (!reparsed.ok) throw new Error(reparsed.error)
    expect(reparsed.problems).toEqual([])
    const added = reparsed.bindings.find((b) => b.command === 'workbench.action.files.saveAll')!
    expect(formatCanonical(added.chord!)).toBe('alt+cmd+s')
  })

  it('opens up an empty array when appending to it', () => {
    const out = mergedContents(fixture('empty-array.json'), [
      { command: 'workbench.action.files.save', chord: parseCanonical('cmd+s') }
    ])

    expect(out).toBe(
      [
        '// Place your key bindings in this file to override the defaults',
        '[',
        '  {',
        '    "key": "cmd+s",',
        '    "command": "workbench.action.files.save"',
        '  }',
        ']',
        ''
      ].join('\n')
    )
  })

  it('creates usable contents from an empty or absent file', () => {
    const outcome = vscodeAdapter.parse(vscodeAdapter.emptyContents())
    expect(outcome).toEqual({ ok: true, bindings: [], problems: [] })

    for (const absent of ['', '   \n']) {
      const out = mergedContents(absent, [
        { command: 'workbench.action.files.save', chord: parseCanonical('cmd+s') }
      ])
      const reparsed = vscodeAdapter.parse(out)
      if (!reparsed.ok) throw new Error(reparsed.error)
      expect(reparsed.bindings).toHaveLength(1)
      expect(formatCanonical(reparsed.bindings[0].chord!)).toBe('cmd+s')
    }
  })

  it('unbinds by negation, never by deletion', () => {
    // The user has their own entry for this command, and VSCode ships a default
    // for it too — both have to be negated or the command stays reachable.
    const out = mergedContents(fixture('basic.json'), [
      { command: 'workbench.action.findInFiles', chord: null }
    ])

    expect(out).toContain(
      [
        '  {',
        '    "key": "ctrl+shift+f",',
        '    "command": "-workbench.action.findInFiles",',
        '    "when": "!editorFocus"',
        '  },'
      ].join('\n')
    )
    expect(out).toContain('"key": "cmd+shift+f",')
    expect(out).toContain('"command": "-workbench.action.findInFiles"')

    const reparsed = vscodeAdapter.parse(out)
    if (!reparsed.ok) throw new Error(reparsed.error)
    const negations = reparsed.bindings.filter((b) => b.command === 'workbench.action.findInFiles')
    expect(negations).toHaveLength(2)
    expect(negations.every((b) => b.negated === true)).toBe(true)
    expect(negations.map((b) => formatCanonical(b.chord!)).sort()).toEqual([
      'ctrl+shift+f',
      'shift+cmd+f'
    ])
  })

  it('keeps an existing negation entry rather than duplicating it', () => {
    const contents = fixture('basic.json')
    const out = mergedContents(contents, [
      { command: 'workbench.action.toggleZenMode', chord: null }
    ])
    expect(out).toBe(contents)
  })

  it('binds a command that is currently negated by appending, leaving the negation intact', () => {
    const out = mergedContents(fixture('basic.json'), [
      { command: 'workbench.action.toggleZenMode', chord: parseCanonical('ctrl+alt+z') }
    ])

    expect(out).toContain('"command": "-workbench.action.toggleZenMode"')
    expect(out).toContain('"key": "ctrl+alt+z",')

    const reparsed = vscodeAdapter.parse(out)
    if (!reparsed.ok) throw new Error(reparsed.error)
    const zen = reparsed.bindings.filter((b) => b.command === 'workbench.action.toggleZenMode')
    expect(zen.map((b) => b.negated)).toEqual([true, undefined])
  })

  it('skips a chord VSCode cannot express instead of dropping it silently', () => {
    const contents = fixture('basic.json')
    const inexpressible = chord(stroke('a'), stroke('b'), stroke('c'))
    const outcome = vscodeAdapter.merge(contents, [
      { command: 'workbench.action.files.save', chord: inexpressible },
      { command: 'workbench.action.quickOpen', chord: parseCanonical('cmd+p') }
    ])
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('workbench.action.files.save')
    expect(outcome.skipped[0].chord).toBe(inexpressible)
    expect(outcome.skipped[0].reason).toBeTruthy()
    expect(outcome.contents).not.toContain('workbench.action.files.save')
    expect(outcome.contents).toContain('workbench.action.quickOpen')
  })

  it('refuses to write to a file it cannot parse', () => {
    const outcome = vscodeAdapter.merge(fixture('malformed.json'), [
      { command: 'workbench.action.files.save', chord: parseCanonical('cmd+s') }
    ])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('refusing to write')
  })

  it('preserves CRLF line endings when appending', () => {
    const contents = fixture('empty-array.json').replace(/\n/g, '\r\n')
    const out = mergedContents(contents, [
      { command: 'workbench.action.files.save', chord: parseCanonical('cmd+s') }
    ])
    expect(out).toContain('\r\n  {\r\n    "key": "cmd+s",')
    expect(out).not.toMatch(/[^\r]\n/)
  })
})

describe('defaults', () => {
  it('reports itself as a partial, curated set with a reason', () => {
    const report = vscodeAdapter.defaults('vscode')
    expect(report.availability).toBe('partial')
    expect(report.note).toContain('compiles its default keybindings into the application')
    expect(report.bindings.length).toBeGreaterThanOrEqual(25)
    expect(report.bindings.every((b) => b.source === 'default')).toBe(true)
    expect(report.bindings.every((b) => b.negated === undefined)).toBe(true)
  })

  it('gives Cursor the same set, since it is a VSCode fork', () => {
    expect(vscodeAdapter.defaults('cursor')).toEqual(vscodeAdapter.defaults('vscode'))
  })

  it('carries the well-known macOS chords', () => {
    const report = vscodeAdapter.defaults('vscode')
    const byCommand = new Map(report.bindings.map((b) => [b.command, formatCanonical(b.chord!)]))

    expect(Object.fromEntries(byCommand)).toMatchObject({
      'workbench.action.files.save': 'cmd+s',
      'workbench.action.files.saveAll': 'alt+cmd+s',
      'workbench.action.showCommands': 'shift+cmd+p',
      'workbench.action.quickOpen': 'cmd+p',
      'workbench.action.gotoLine': 'ctrl+g',
      'actions.find': 'cmd+f',
      'editor.action.startFindReplaceAction': 'alt+cmd+f',
      'workbench.action.findInFiles': 'shift+cmd+f',
      'editor.action.commentLine': 'cmd+/',
      'workbench.action.openGlobalKeybindings': 'cmd+k cmd+s',
      'workbench.action.terminal.toggleTerminal': 'ctrl+`'
    })
  })

  it('has no duplicate commands', () => {
    const commands = vscodeAdapter.defaults('vscode').bindings.map((b) => b.command)
    expect(new Set(commands).size).toBe(commands.length)
  })
})
