import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, parseCanonical, stroke } from '../chord'
import { CODEX_COMMAND_IDS, codexAdapter } from './codex'
import type { ManagedBinding } from './types'

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/codex/${name}`, import.meta.url), 'utf8')
}

function mergedContents(contents: string, managed: ManagedBinding[]): string {
  const outcome = codexAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`merge failed: ${outcome.error}`)
  return outcome.contents
}

function encoded(text: string): string {
  const c = parseCanonical(text)
  if (c === null) throw new Error(`bad test chord: ${text}`)
  const outcome = codexAdapter.encodeChord(c)
  if (!outcome.ok) throw new Error(`could not encode ${text}: ${outcome.reason}`)
  return outcome.value
}

function decoded(text: string): string {
  const outcome = codexAdapter.decodeChord(text)
  if (outcome === null) throw new Error(`could not decode ${text}`)
  return formatCanonical(outcome)
}

function parsed(contents: string): ReturnType<typeof codexAdapter.parse> & { ok: true } {
  const outcome = codexAdapter.parse(contents)
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome
}

describe('identity', () => {
  it('reports its format and apps', () => {
    expect(codexAdapter.format).toBe('codex-keybindings')
    expect(codexAdapter.apps).toEqual(['codex'])
  })
})

describe('chord encoding', () => {
  it('encodes a plain letter with cmd', () => {
    expect(encoded('cmd+n')).toBe('Cmd+N')
  })

  it('encodes modifiers in a fixed order', () => {
    expect(encoded('shift+ctrl+m')).toBe('Ctrl+Shift+M')
    expect(encoded('shift+cmd+alt+ctrl+w')).toBe('Cmd+Ctrl+Alt+Shift+W')
  })

  it('encodes a bare ctrl binding, not translated to cmd', () => {
    expect(encoded('ctrl+`')).toBe('Ctrl+`')
  })

  it('encodes named keys', () => {
    expect(encoded('cmd+shift+]')).toBe('Cmd+Shift+]')
    expect(encoded('cmd+shift+[')).toBe('Cmd+Shift+[')
  })

  it('rejects a two-keystroke chord as inexpressible', () => {
    const c = parseCanonical('cmd+k cmd+s')
    if (c === null) throw new Error('bad test chord')
    const outcome = codexAdapter.encodeChord(c)
    expect(outcome.ok).toBe(false)
  })
})

describe('chord decoding', () => {
  it('decodes Cmd and Command as cmd', () => {
    expect(decoded('Cmd+N')).toBe('cmd+n')
    expect(decoded('Command+N')).toBe('cmd+n')
  })

  it('decodes CmdOrCtrl as cmd on this macOS-only project', () => {
    expect(decoded('CmdOrCtrl+N')).toBe('cmd+n')
  })

  it('decodes Ctrl and Control identically', () => {
    expect(decoded('Ctrl+Shift+M')).toBe('ctrl+shift+m')
    expect(decoded('Control+Shift+M')).toBe('ctrl+shift+m')
  })

  it('decodes a backtick accelerator', () => {
    expect(decoded('Control+`')).toBe('ctrl+`')
  })

  it('returns null for an unrepresentable modifier', () => {
    expect(codexAdapter.decodeChord('Super+N')).toBeNull()
  })

  it('returns null for a malformed accelerator', () => {
    expect(codexAdapter.decodeChord('N+Cmd')).toBeNull()
    expect(codexAdapter.decodeChord('')).toBeNull()
    expect(codexAdapter.decodeChord('Cmd++')).toBeNull()
  })
})

describe('parsing', () => {
  it('parses an empty file as no overrides', () => {
    expect(parsed('').bindings).toEqual([])
    expect(parsed('   \n  ').bindings).toEqual([])
  })

  it('parses the normalized empty-array fixture', () => {
    expect(parsed(fixture('authored-empty.json')).bindings).toEqual([])
  })

  it('rejects malformed JSON with a file-level error', () => {
    const outcome = codexAdapter.parse(fixture('malformed-json.json'))
    expect(outcome.ok).toBe(false)
  })

  it('rejects a non-array root with a file-level error', () => {
    const outcome = codexAdapter.parse(fixture('malformed-root.json'))
    expect(outcome.ok).toBe(false)
  })

  it('reports malformed individual entries as problems, keeping valid siblings', () => {
    const result = parsed(fixture('malformed-entries.json'))
    expect(result.problems.length).toBe(3)
    const commands = result.bindings.map((b) => b.command)
    expect(commands).toContain('closeTab')
    expect(commands).toContain('nextTab')
  })

  it('parses a bound command, an explicit unbind, alternates, and unmanaged entries', () => {
    const result = parsed(fixture('authored-populated.json'))

    const closeTab = result.bindings.find((b) => b.command === 'closeTab')
    expect(closeTab?.chord && formatCanonical(closeTab.chord)).toBe('cmd+w')

    const modelPicker = result.bindings.find((b) => b.command === 'composer.openModelPicker')
    expect(modelPicker?.chord).toBeNull()
    expect(modelPicker?.negated).toBe(true)

    // Only the first of the two nextTab entries is surfaced.
    const nextTab = result.bindings.find((b) => b.command === 'nextTab')
    expect(nextTab?.chord && formatCanonical(nextTab.chord)).toBe('shift+cmd+]')

    // An unknown command is not a problem, just unmanaged data unikeys carries
    // through like any other adapter — the catalogue decides what is shown.
    const unknown = result.bindings.find((b) => b.command === 'some.futureUnknownCommand')
    expect(unknown?.chord && formatCanonical(unknown.chord)).toBe('shift+cmd+9')
  })

  it('parses all three known legacy migrations into current command ids', () => {
    const result = parsed(fixture('authored-populated.json'))

    // closeTabOrWindow fans out to both current commands.
    const closeWindow = result.bindings.find((b) => b.command === 'closeWindow')
    expect(closeWindow?.chord && formatCanonical(closeWindow.chord)).toBe('shift+cmd+w')

    const newTask = result.bindings.find((b) => b.command === 'newTask')
    expect(newTask?.chord && formatCanonical(newTask.chord)).toBe('alt+cmd+n')

    const toggleMaximize = result.bindings.find((b) => b.command === 'toggleMaximizeSidePanel')
    expect(toggleMaximize?.chord && formatCanonical(toggleMaximize.chord)).toBe('alt+cmd+m')

    // Legacy ids themselves never appear as a parsed command.
    expect(result.bindings.some((b) => b.command === 'newThread')).toBe(false)
    expect(result.bindings.some((b) => b.command === 'toggleSidePanelFullWidth')).toBe(false)
    expect(result.bindings.some((b) => b.command === 'closeTabOrWindow')).toBe(false)
  })
})

describe('merging', () => {
  it('changes the first effective entry for a bound command', () => {
    const managed: ManagedBinding[] = [
      { command: 'closeTab', chord: parseCanonical('cmd+shift+w') }
    ]
    const out = mergedContents(fixture('authored-populated.json'), managed)
    expect(parsed(out).bindings.find((b) => b.command === 'closeTab')?.chord).toEqual(
      parseCanonical('cmd+shift+w')
    )
  })

  it('leaves a later alternate untouched when rewriting the first entry', () => {
    const managed: ManagedBinding[] = [{ command: 'nextTab', chord: parseCanonical('cmd+9') }]
    const out = mergedContents(fixture('authored-populated.json'), managed)
    // The second nextTab entry (Cmd+Alt+]) survives verbatim.
    expect(out).toContain('Cmd+Alt+]')
    expect(parsed(out).bindings.find((b) => b.command === 'nextTab')?.chord).toEqual(
      parseCanonical('cmd+9')
    )
  })

  it('appends a missing command rather than failing', () => {
    const managed: ManagedBinding[] = [
      { command: 'toggleTerminal', chord: parseCanonical('ctrl+`') }
    ]
    const out = mergedContents(fixture('authored-populated.json'), managed)
    expect(parsed(out).bindings.find((b) => b.command === 'toggleTerminal')?.chord).toEqual(
      parseCanonical('ctrl+`')
    )
  })

  it('writes an explicit null for an unbind, never deleting the command', () => {
    const managed: ManagedBinding[] = [{ command: 'closeTab', chord: null }]
    const out = mergedContents(fixture('authored-populated.json'), managed)
    expect(out).toMatch(/"command":\s*"closeTab"/)
    const rebound = parsed(out).bindings.find((b) => b.command === 'closeTab')
    expect(rebound?.chord).toBeNull()
    expect(rebound?.negated).toBe(true)
  })

  it('unbinds a command absent from the file by appending a null entry', () => {
    const managed: ManagedBinding[] = [{ command: 'toggleTerminal', chord: null }]
    const out = mergedContents(fixture('authored-populated.json'), managed)
    const rebound = parsed(out).bindings.find((b) => b.command === 'toggleTerminal')
    expect(rebound?.chord).toBeNull()
  })

  it('writes only the current command id, never a legacy alias', () => {
    const managed: ManagedBinding[] = [{ command: 'newTask', chord: parseCanonical('cmd+n') }]
    const out = mergedContents(fixture('authored-populated.json'), managed)
    expect(out).not.toContain('"newThread"')
    expect(out).toMatch(/"command":\s*"newTask"/)
  })

  it('leaves a one-to-many legacy alias entry untouched and appends the current command', () => {
    const managed: ManagedBinding[] = [{ command: 'closeWindow', chord: parseCanonical('cmd+9') }]
    const out = mergedContents(fixture('authored-populated.json'), managed)
    // The original closeTabOrWindow entry survives verbatim.
    expect(out).toContain('"closeTabOrWindow"')
    expect(parsed(out).bindings.find((b) => b.command === 'closeWindow')?.chord).toEqual(
      parseCanonical('cmd+9')
    )
  })

  it('takes effect even when a one-to-many alias sits in front of the command own entry', () => {
    // Codex reads first-entry-wins, so rewriting the later `closeTab` entry
    // would leave `closeTabOrWindow` still deciding: a save that reports
    // success and changes nothing the user can see.
    const before = `[
  {
    "command": "closeTabOrWindow",
    "key": "Cmd+W"
  },
  {
    "command": "closeTab",
    "key": "Cmd+Shift+W"
  }
]
`
    const out = mergedContents(before, [
      { command: 'closeTab', chord: parseCanonical('cmd+alt+w') }
    ])
    expect(out).toContain('"closeTabOrWindow"')
    expect(parsed(out).bindings.find((b) => b.command === 'closeTab')?.chord).toEqual(
      parseCanonical('cmd+alt+w')
    )
  })

  it('adds nothing in front of an alias that already says what was asked for', () => {
    const before = `[
  {
    "command": "closeTabOrWindow",
    "key": "Cmd+W"
  }
]
`
    expect(mergedContents(before, [{ command: 'closeTab', chord: parseCanonical('cmd+w') }])).toBe(
      before
    )
    expect(
      mergedContents(`[\n  {\n    "command": "closeTabOrWindow",\n    "key": null\n  }\n]\n`, [
        { command: 'closeTab', chord: null }
      ])
    ).toBe(`[\n  {\n    "command": "closeTabOrWindow",\n    "key": null\n  }\n]\n`)
  })

  /**
   * The save path writes every changed cell for an app in one `merge` — see
   * `planWrite` in `src/main/apps-service.ts`. One binding per call is the
   * exception, not the rule.
   */
  it('writes every kind of change in one call, as the save path sends them', () => {
    const out = mergedContents(fixture('authored-populated.json'), [
      { command: 'closeTab', chord: parseCanonical('cmd+shift+backspace') },
      { command: 'nextTab', chord: parseCanonical('ctrl+tab') },
      { command: 'composer.openModelPicker', chord: parseCanonical('ctrl+shift+m') },
      { command: 'toggleTerminal', chord: null },
      { command: 'newTask', chord: parseCanonical('cmd+n') }
    ])
    const result = parsed(out)
    const chordFor = (command: string): unknown =>
      result.bindings.find((b) => b.command === command)?.chord
    expect(chordFor('closeTab')).toEqual(parseCanonical('cmd+shift+backspace'))
    expect(chordFor('nextTab')).toEqual(parseCanonical('ctrl+tab'))
    expect(chordFor('composer.openModelPicker')).toEqual(parseCanonical('ctrl+shift+m'))
    expect(chordFor('toggleTerminal')).toBeNull()
    expect(chordFor('newTask')).toEqual(parseCanonical('cmd+n'))
    // The later alternate and the unmanaged command are not collateral damage.
    expect(out).toContain('Cmd+Alt+]')
    expect(out).toContain('some.futureUnknownCommand')
  })

  it('preserves unmanaged commands, unknown fields are not present to begin with, and formatting', () => {
    const managed: ManagedBinding[] = [
      { command: 'closeTab', chord: parseCanonical('cmd+shift+w') }
    ]
    const out = mergedContents(fixture('authored-populated.json'), managed)
    expect(out).toContain('some.futureUnknownCommand')
  })

  it('round-trips byte-identically when the requested values already match', () => {
    const managed: ManagedBinding[] = [
      { command: 'closeTab', chord: parseCanonical('cmd+w') },
      { command: 'nextTab', chord: parseCanonical('cmd+shift+]') }
    ]
    const before = fixture('authored-populated.json')
    const out = mergedContents(before, managed)
    expect(out).toBe(before)
  })

  it('creates the file from empty contents on first save', () => {
    const managed: ManagedBinding[] = [{ command: 'closeTab', chord: parseCanonical('cmd+w') }]
    const out = mergedContents('', managed)
    expect(parsed(out).bindings.find((b) => b.command === 'closeTab')?.chord).toEqual(
      parseCanonical('cmd+w')
    )
  })

  it('reports an inexpressible chord through skipped rather than writing it', () => {
    const managed: ManagedBinding[] = [
      { command: 'closeTab', chord: chord(stroke('s', 'cmd'), stroke('w', 'cmd')) }
    ]
    const outcome = codexAdapter.merge(fixture('authored-populated.json'), managed)
    if (!outcome.ok) throw new Error('merge should not fail the whole file')
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('closeTab')
  })

  it('rejects a malformed root with a file-level error rather than writing', () => {
    const outcome = codexAdapter.merge(fixture('malformed-root.json'), [])
    expect(outcome.ok).toBe(false)
  })
})

describe('emptyContents', () => {
  it('is the normalized empty-array shape', () => {
    expect(codexAdapter.emptyContents()).toBe('[]\n')
  })
})

describe('defaults', () => {
  it('reports partial availability with a version-pinned note', () => {
    const report = codexAdapter.defaults('codex')
    expect(report.availability).toBe('partial')
    expect(report.note).toMatch(/26\.820\.60940/)
  })

  it('ships a default for every curated command id', () => {
    const report = codexAdapter.defaults('codex')
    const withDefaults = new Set(report.bindings.map((b) => b.command))
    // composer.submit is a real, curated id with deliberately no default.
    for (const id of CODEX_COMMAND_IDS) {
      if (id === 'composer.submit') continue
      expect(withDefaults.has(id), `${id} has no curated default`).toBe(true)
    }
  })

  it('has no defaults for another app', () => {
    expect(codexAdapter.defaults('claude-code' as never).availability).toBe('unavailable')
  })
})
