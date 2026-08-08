import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, parseCanonical, stroke } from '../chord'
import { ACTIONS } from '../catalogue'
import { obsidianAdapter } from './obsidian'
import type { ManagedBinding } from './types'

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/obsidian/${name}`, import.meta.url), 'utf8')
}

/** Merges and fails loudly, so every merge assertion reads as one expression. */
function mergedContents(contents: string, managed: ManagedBinding[]): string {
  const outcome = obsidianAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`merge failed: ${outcome.error}`)
  return outcome.contents
}

function encoded(text: string): string {
  const parsed = parseCanonical(text)
  if (parsed === null) throw new Error(`bad test chord: ${text}`)
  const outcome = obsidianAdapter.encodeChord(parsed)
  if (!outcome.ok) throw new Error(`could not encode ${text}: ${outcome.reason}`)
  return outcome.value
}

function decoded(text: string): string {
  const outcome = obsidianAdapter.decodeChord(text)
  if (outcome === null) throw new Error(`could not decode ${text}`)
  return formatCanonical(outcome)
}

function parsed(contents: string): ReturnType<typeof obsidianAdapter.parse> & { ok: true } {
  const outcome = obsidianAdapter.parse(contents)
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome
}

describe('identity', () => {
  it('serves Obsidian alone', () => {
    expect(obsidianAdapter.format).toBe('obsidian-hotkeys')
    expect(obsidianAdapter.apps).toEqual(['obsidian'])
  })
})

/**
 * The trap this adapter exists to avoid: `Mod` is Command on macOS, not
 * Control. A table with the two swapped round-trips perfectly, so every
 * assertion here is anchored to a literal on one side or the other.
 */
describe('Mod is Cmd and Ctrl is Ctrl', () => {
  it('writes cmd as Mod and ctrl as Ctrl', () => {
    expect(encoded('cmd+s')).toBe('Mod+S')
    expect(encoded('ctrl+s')).toBe('Ctrl+S')
    expect(encoded('ctrl+cmd+f')).toBe('Mod+Ctrl+F')
  })

  it('reads Mod as cmd and Ctrl as ctrl', () => {
    expect(decoded('Mod+S')).toBe('cmd+s')
    expect(decoded('Ctrl+S')).toBe('ctrl+s')
    expect(decoded('Mod+Ctrl+F')).toBe('ctrl+cmd+f')
  })

  it('reads Meta as cmd too, which is what Obsidian writes for an explicit ⌘', () => {
    expect(decoded('Meta+S')).toBe('cmd+s')
  })

  it('keeps the two apart through a whole file', () => {
    const outcome = parsed(fixture('modifier-mix.json'))
    const byCommand = new Map(
      outcome.bindings.map((b) => [b.command, b.chord === null ? null : formatCanonical(b.chord)])
    )

    expect(Object.fromEntries(byCommand)).toMatchObject({
      'command-palette:open': 'cmd+p',
      'switcher:open': 'ctrl+o',
      'global-search:open': 'ctrl+cmd+f',
      'app:go-back': 'cmd+[',
      'editor:save-file': 'ctrl+alt+shift+cmd+s'
    })
  })
})

describe('encodeChord', () => {
  it('writes the DOM spelling of every named key', () => {
    expect(encoded('alt+down')).toBe('Alt+ArrowDown')
    expect(encoded('cmd+up')).toBe('Mod+ArrowUp')
    expect(encoded('cmd+pagedown')).toBe('Mod+PageDown')
    expect(encoded('escape')).toBe('Escape')
    expect(encoded('cmd+enter')).toBe('Mod+Enter')
    expect(encoded('shift+backspace')).toBe('Shift+Backspace')
    expect(encoded('f5')).toBe('F5')
  })

  it('writes letters uppercase and punctuation literally', () => {
    expect(encoded('cmd+o')).toBe('Mod+O')
    expect(encoded('shift+cmd+\\')).toBe('Mod+Shift+\\')
    expect(encoded('cmd+-')).toBe('Mod+-')
    expect(encoded('cmd+/')).toBe('Mod+/')
    expect(encoded('cmd+1')).toBe('Mod+1')
  })

  it('spells the space key so it survives being read back', () => {
    expect(encoded('cmd+space')).toBe('Mod+Space')
    expect(decoded('Mod+Space')).toBe('cmd+space')
  })

  it('reports a two-keystroke chord as inexpressible rather than truncating it', () => {
    const sequence = chord(stroke('k', 'cmd'), stroke('s', 'cmd'))
    expect(obsidianAdapter.encodeChord(sequence)).toEqual({
      ok: false,
      reason: expect.stringContaining('one keystroke')
    })
  })

  it('reports a chord it has no key for rather than guessing', () => {
    expect(obsidianAdapter.encodeChord({ strokes: [] })).toEqual({
      ok: false,
      reason: expect.stringContaining('no keystrokes')
    })
    expect(obsidianAdapter.encodeChord({ strokes: [{ modifiers: [], key: 'eject' }] })).toEqual({
      ok: false,
      reason: expect.stringContaining('eject')
    })
  })
})

describe('decodeChord', () => {
  it('reads named keys back into the canonical vocabulary', () => {
    expect(decoded('Alt+ArrowDown')).toBe('alt+down')
    expect(decoded('Mod+PageDown')).toBe('cmd+pagedown')
    expect(decoded('Escape')).toBe('escape')
    expect(decoded('F12')).toBe('f12')
    expect(decoded('Mod+Shift+\\')).toBe('shift+cmd+\\')
  })

  it('returns null for notation it cannot represent', () => {
    expect(obsidianAdapter.decodeChord('')).toBeNull()
    expect(obsidianAdapter.decodeChord('Mod+')).toBeNull()
    expect(obsidianAdapter.decodeChord('Mod+Compose')).toBeNull()
    expect(obsidianAdapter.decodeChord('S+Mod')).toBeNull()
    // VSCode notation is not Obsidian notation: `cmd` is not one of its words.
    expect(obsidianAdapter.decodeChord('cmd+s')).toBeNull()
    // Obsidian has no key sequences, so text naming two keystrokes is not one.
    expect(obsidianAdapter.decodeChord('Mod+K Mod+S')).toBeNull()
  })

  it('round-trips every chord it decodes', () => {
    for (const text of ['Mod+Shift+P', 'Ctrl+O', 'Mod+Ctrl+F', 'Alt+ArrowDown', 'F5', 'Mod+-']) {
      const decodedChord = obsidianAdapter.decodeChord(text)!
      expect(obsidianAdapter.encodeChord(decodedChord)).toEqual({ ok: true, value: text })
    }
  })
})

describe('parse', () => {
  it('reads a real-shaped override file', () => {
    const outcome = parsed(fixture('populated.json'))

    expect(outcome.problems).toEqual([])
    expect(outcome.bindings.map((b) => b.command)).toEqual([
      'command-palette:open',
      'switcher:open',
      'editor:swap-line-down',
      'workspace:split-vertical',
      'app:go-back'
    ])
    expect(outcome.bindings.every((b) => b.source === 'user')).toBe(true)
    expect(formatCanonical(outcome.bindings[0].chord!)).toBe('shift+cmd+p')
    expect(formatCanonical(outcome.bindings[3].chord!)).toBe('shift+cmd+\\')
  })

  it('reads an empty array as an explicit unbind, not as a command never mentioned', () => {
    const outcome = parsed(fixture('populated.json'))
    const back = outcome.bindings.find((b) => b.command === 'app:go-back')!

    expect(back.negated).toBe(true)
    expect(back.chord).toBeNull()
    // Nothing else is mistaken for one.
    expect(outcome.bindings.filter((b) => b.negated === true)).toHaveLength(1)
  })

  it('reads the pretty-printed layout Obsidian itself writes', () => {
    const outcome = parsed(fixture('expanded.json'))
    expect(outcome.problems).toEqual([])
    expect(formatCanonical(outcome.bindings[0].chord!)).toBe('shift+cmd+f')
    expect(formatCanonical(outcome.bindings[1].chord!)).toBe('cmd+-')
    expect(outcome.bindings[2].negated).toBe(true)
  })

  it('shows only the first of several bindings for one command', () => {
    const outcome = parsed(fixture('alternates.json'))
    const search = outcome.bindings.filter((b) => b.command === 'global-search:open')

    expect(search).toHaveLength(1)
    expect(formatCanonical(search[0].chord!)).toBe('shift+cmd+f')
  })

  it('reads the space key and an unmodified key', () => {
    const outcome = parsed(fixture('modifier-mix.json'))
    const byCommand = new Map(outcome.bindings.map((b) => [b.command, b.chord]))

    expect(formatCanonical(byCommand.get('workspace:close')!)).toBe('cmd+space')
    expect(formatCanonical(byCommand.get('app:go-forward')!)).toBe('f5')
    expect(formatCanonical(byCommand.get('workspace:next-tab')!)).toBe('alt+shift+pagedown')
  })

  it('reports a bad entry as a problem rather than failing the file', () => {
    const outcome = parsed(fixture('tricky.json'))

    expect(outcome.bindings.map((b) => b.command)).toEqual(['editor:save-file', 'switcher:open'])
    expect(outcome.problems).toHaveLength(5)
    const messages = outcome.problems.map((p) => p.message).join('\n')
    expect(messages).toContain('"workspace:close" is not an array')
    expect(messages).toContain('"app:go-forward" has no key')
    expect(messages).toContain('Hyper')
    expect(messages).toContain('Compose')
    expect(messages).toContain('"workspace:next-tab" is not an object')
    expect(outcome.problems.every((p) => p.detail !== undefined)).toBe(true)
  })

  it('gives a repeated command id to the last one, as JSON and Obsidian both do', () => {
    const outcome = parsed(fixture('tricky.json'))
    const switcher = outcome.bindings.filter((b) => b.command === 'switcher:open')

    expect(switcher).toHaveLength(1)
    expect(formatCanonical(switcher[0].chord!)).toBe('shift+cmd+o')
  })

  it('treats {} and an empty file as nothing overridden', () => {
    for (const contents of [fixture('empty.json'), obsidianAdapter.emptyContents(), '', '  \n\n']) {
      expect(obsidianAdapter.parse(contents)).toEqual({ ok: true, bindings: [], problems: [] })
    }
  })

  it('fails the whole file for malformed JSON', () => {
    const outcome = obsidianAdapter.parse(fixture('malformed.json'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('not valid JSON')
  })

  it('fails when the root is not an object', () => {
    const outcome = obsidianAdapter.parse('[{ "modifiers": ["Mod"], "key": "S" }]')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('object')
  })
})

describe('merge', () => {
  it('returns byte-identical contents when nothing changes', () => {
    const contents = fixture('populated.json')
    const managed: ManagedBinding[] = [
      { command: 'command-palette:open', chord: parseCanonical('shift+cmd+p') },
      { command: 'switcher:open', chord: parseCanonical('cmd+o') },
      { command: 'editor:swap-line-down', chord: parseCanonical('alt+down') },
      { command: 'workspace:split-vertical', chord: parseCanonical('shift+cmd+\\') },
      { command: 'app:go-back', chord: null }
    ]
    expect(mergedContents(contents, managed)).toBe(contents)
  })

  it('returns byte-identical contents when nothing is managed', () => {
    const contents = fixture('expanded.json')
    expect(mergedContents(contents, [])).toBe(contents)
  })

  it('does not churn a binding written with Meta or in another modifier order', () => {
    const contents = fixture('modifier-mix.json')
    const managed: ManagedBinding[] = [
      // The file says ["Meta"]; unikeys would write ["Mod"]. Same key.
      { command: 'app:go-back', chord: parseCanonical('cmd+[') },
      { command: 'global-search:open', chord: parseCanonical('ctrl+cmd+f') },
      { command: 'editor:save-file', chord: parseCanonical('ctrl+alt+shift+cmd+s') }
    ]
    expect(mergedContents(contents, managed)).toBe(contents)
  })

  it('is idempotent — merging its own output changes nothing further', () => {
    const managed: ManagedBinding[] = [
      { command: 'switcher:open', chord: parseCanonical('shift+cmd+o') },
      { command: 'app:go-back', chord: null },
      { command: 'editor:save-file', chord: parseCanonical('cmd+s') },
      { command: 'workspace:close', chord: null }
    ]
    const once = mergedContents(fixture('populated.json'), managed)
    expect(mergedContents(once, managed)).toBe(once)
  })

  it('rewrites a binding in place, leaving the file’s own layout alone', () => {
    const out = mergedContents(fixture('expanded.json'), [
      { command: 'global-search:open', chord: parseCanonical('shift+cmd+g') }
    ])

    expect(out).toContain(
      [
        '  "global-search:open": [',
        '    {',
        '      "modifiers": [',
        '        "Mod",',
        '        "Shift"',
        '      ],',
        '      "key": "G"',
        '    }',
        '  ],'
      ].join('\n')
    )
    // Everything else is byte-for-byte as it was.
    const untouched = (text: string): string[] =>
      text.split('\n').filter((line) => !line.includes('"key": "'))
    expect(untouched(out)).toEqual(untouched(fixture('expanded.json')))
  })

  it('rewrites the modifiers when only they change', () => {
    const out = mergedContents(fixture('expanded.json'), [
      { command: 'workspace:split-horizontal', chord: parseCanonical('alt+-') }
    ])

    expect(out).toContain('      "modifiers": ["Alt"],\n      "key": "-"')
    expect(out).toContain('"global-search:open"')
    expect(obsidianAdapter.parse(out).ok).toBe(true)
  })

  it('leaves the alternate bindings of a managed command untouched', () => {
    const out = mergedContents(fixture('alternates.json'), [
      { command: 'global-search:open', chord: parseCanonical('cmd+g') }
    ])

    expect(out).toContain('{ "modifiers": ["Mod"], "key": "G" },')
    expect(out).toContain('{ "modifiers": ["Mod"], "key": "F" },')
    expect(out).toContain('{ "modifiers": ["Ctrl", "Alt"], "key": "F" }')
    expect(out).toContain('"workspace:close": [{ "modifiers": ["Mod"], "key": "W" }]')
  })

  it('unbinds by emptying the array, which is what suppresses the shipped default', () => {
    const out = mergedContents(fixture('alternates.json'), [
      { command: 'global-search:open', chord: null }
    ])

    expect(out).toContain('"global-search:open": [],')
    // Every alternate goes with it: one left behind would keep firing.
    expect(out).not.toContain('"key": "F"')
    expect(out).toContain('"workspace:close": [{ "modifiers": ["Mod"], "key": "W" }]')

    const reparsed = parsed(out)
    const search = reparsed.bindings.find((b) => b.command === 'global-search:open')!
    expect(search.negated).toBe(true)
    expect(search.chord).toBeNull()
  })

  it('adds an empty array for a command the file never mentions', () => {
    // Without this the command keeps its shipped default and the unbind does
    // nothing at all.
    const out = mergedContents(fixture('populated.json'), [
      { command: 'workspace:close', chord: null }
    ])

    expect(out).toContain('"workspace:close": []')
    const reparsed = parsed(out)
    expect(reparsed.bindings.find((b) => b.command === 'workspace:close')!.negated).toBe(true)
  })

  it('binds a command that is currently unbound', () => {
    const out = mergedContents(fixture('populated.json'), [
      { command: 'app:go-back', chord: parseCanonical('cmd+[') }
    ])

    expect(out).toContain('"app:go-back": [{ "modifiers": ["Mod"], "key": "[" }]')
    const reparsed = parsed(out)
    const back = reparsed.bindings.find((b) => b.command === 'app:go-back')!
    expect(back.negated).toBeUndefined()
    expect(formatCanonical(back.chord!)).toBe('cmd+[')
  })

  it('appends a new command in the file’s own indentation', () => {
    const before = fixture('populated.json')
    const out = mergedContents(before, [
      { command: 'editor:save-file', chord: parseCanonical('cmd+s') }
    ])

    expect(out.endsWith('\n')).toBe(true)
    expect(out).toContain(
      '  "app:go-back": [],\n  "editor:save-file": [{ "modifiers": ["Mod"], "key": "S" }]\n}'
    )
    // Appended, not inserted: everything that was there still precedes it.
    expect(out.indexOf('app:go-back')).toBeLessThan(out.indexOf('editor:save-file'))
  })

  it('opens up an empty object when appending to it', () => {
    for (const empty of [fixture('empty.json'), '', '   \n']) {
      const out = mergedContents(empty, [
        { command: 'editor:save-file', chord: parseCanonical('cmd+s') }
      ])
      expect(out).toBe('{\n  "editor:save-file": [{ "modifiers": ["Mod"], "key": "S" }]\n}\n')
    }
  })

  it('creates usable contents from an absent file', () => {
    expect(obsidianAdapter.parse(obsidianAdapter.emptyContents())).toEqual({
      ok: true,
      bindings: [],
      problems: []
    })
  })

  it('preserves CRLF line endings when appending', () => {
    const contents = fixture('populated.json').replace(/\n/g, '\r\n')
    const out = mergedContents(contents, [
      { command: 'editor:save-file', chord: parseCanonical('cmd+s') }
    ])
    expect(out).toContain('\r\n  "editor:save-file": [{ "modifiers": ["Mod"], "key": "S" }]')
    expect(out).not.toMatch(/[^\r]\n/)
  })

  it('replaces a binding whose shape it cannot splice into', () => {
    const out = mergedContents(fixture('tricky.json'), [
      { command: 'app:go-forward', chord: parseCanonical('cmd+]') },
      { command: 'workspace:close', chord: parseCanonical('cmd+w') }
    ])

    expect(out).toContain('"app:go-forward": [{ "modifiers": ["Mod"], "key": "]" }]')
    expect(out).toContain('"workspace:close": [{ "modifiers": ["Mod"], "key": "W" }]')
  })

  it('skips a chord Obsidian cannot express instead of dropping it silently', () => {
    const sequence = chord(stroke('k', 'cmd'), stroke('s', 'cmd'))
    const outcome = obsidianAdapter.merge(fixture('populated.json'), [
      { command: 'editor:save-file', chord: sequence },
      { command: 'switcher:open', chord: parseCanonical('shift+cmd+o') }
    ])
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('editor:save-file')
    expect(outcome.skipped[0].chord).toBe(sequence)
    expect(outcome.contents).not.toContain('editor:save-file')
    expect(outcome.contents).toContain('{ "modifiers": ["Mod", "Shift"], "key": "O" }')
  })

  it('refuses to write to a file it cannot parse', () => {
    const outcome = obsidianAdapter.merge(fixture('malformed.json'), [
      { command: 'switcher:open', chord: parseCanonical('cmd+o') }
    ])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('refusing to write')
  })
})

describe('defaults', () => {
  it('claims nothing, because Obsidian keeps its defaults inside the application', () => {
    const report = obsidianAdapter.defaults('obsidian')
    expect(report.availability).toBe('unavailable')
    expect(report.bindings).toEqual([])
    expect(report.note).toContain('compiles its default hotkeys into the application')
  })
})

/**
 * These read the shipped catalogue rather than the `catalogue-obsidian.json`
 * fragment they were written against: ticket 26 folded the fragment in and
 * deleted it. The "is this a real action id" check went with it — derived from
 * `ACTIONS`, every key is one by construction, and `validateCatalogue` already
 * refuses an unknown app key. Everything else here is still worth asserting.
 */
describe('the catalogue’s Obsidian column', () => {
  const entries = ACTIONS.filter((action) => action.commands.obsidian !== undefined).map(
    (action) => [action.id, action.commands.obsidian as string] as const
  )

  it('maps a handful of rows and leaves the natively-handled ones alone', () => {
    expect(entries.length).toBeGreaterThanOrEqual(8)
    const mapped = entries.map(([id]) => id)
    // Undo, copy, paste and select-all are macOS text-field behaviour in
    // Obsidian and have no command id to bind, so those rows stay
    // not-applicable rather than being invented.
    for (const native of ['edit.undo', 'edit.copy', 'edit.paste', 'edit.select-all']) {
      expect(mapped).not.toContain(native)
    }
  })

  it('names every command in Obsidian’s own id shape', () => {
    for (const [, command] of entries) {
      expect(command, `${command} is not an Obsidian command id`).toMatch(/^[a-z-]+:[a-z-]+$/)
    }
  })
})
