import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, stroke } from '../chord'
import catalogueData from '../catalogue/catalogue.json'
import warpCommands from '../catalogue/catalogue-warp.json'
import type { ManagedBinding, MergeOutcome, ParseOutcome } from './types'
import { warpAdapter, WARP_ACTION_IDS } from './warp'

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/warp/${name}`, import.meta.url)),
    'utf8'
  )
}

const POPULATED = fixture('populated.yaml')
const UNBOUND = fixture('unbound.yaml')
const NESTED = fixture('nested.yaml')
const NO_TRAILING_NEWLINE = fixture('no-trailing-newline.yaml')
const NOT_A_MAP = fixture('not-a-map.yaml')

const FIXTURES: Array<[string, string]> = [
  ['populated.yaml', POPULATED],
  ['unbound.yaml', UNBOUND],
  ['nested.yaml', NESTED],
  ['no-trailing-newline.yaml', NO_TRAILING_NEWLINE]
]

function parsed(contents: string): Extract<ParseOutcome, { ok: true }> {
  const outcome = warpAdapter.parse(contents)
  if (!outcome.ok) throw new Error(`expected parse to succeed: ${outcome.error}`)
  return outcome
}

function merged(contents: string, managed: ManagedBinding[]): Extract<MergeOutcome, { ok: true }> {
  const outcome = warpAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`expected merge to succeed: ${outcome.error}`)
  return outcome
}

function chordFor(contents: string, command: string): string | null {
  const binding = parsed(contents).bindings.find((b) => b.command === command)
  return binding?.chord ? formatCanonical(binding.chord) : null
}

describe('parse', () => {
  it('reads bindings whether the key and value are quoted or bare', () => {
    expect(chordFor(POPULATED, 'pane_group:add_right')).toBe('cmd+d')
    expect(chordFor(POPULATED, 'terminal:copy')).toBe('cmd+c')
    expect(chordFor(POPULATED, 'terminal:paste')).toBe('cmd+v')
    expect(chordFor(POPULATED, 'pane_group:navigate_left')).toBe('alt+cmd+left')
  })

  it('keeps the colon inside a Warp action name out of the key/value split', () => {
    const commands = parsed(POPULATED).bindings.map((b) => b.command)
    expect(commands).toContain('workspace:new_tab')
    expect(commands).toContain('pane_group:navigate_right')
  })

  it('tolerates the spacing a hand-edited file picks up', () => {
    // `"workspace:new_tab":   cmd-t` and `pane_group:navigate_right : alt-cmd-right`
    expect(chordFor(POPULATED, 'workspace:new_tab')).toBe('cmd+t')
    expect(chordFor(POPULATED, 'pane_group:navigate_right')).toBe('alt+cmd+right')
  })

  it('ignores a trailing comment without losing the binding before it', () => {
    expect(chordFor(POPULATED, 'workspace:activate_next_tab')).toBe('shift+cmd+]')
  })

  it('reads a hyphen used as the key rather than as a separator', () => {
    expect(chordFor(POPULATED, 'workspace:decrease_font_size')).toBe('cmd+-')
  })

  it('reports Warp’s `meta` rather than misreading it as cmd', () => {
    const { bindings, problems } = parsed(POPULATED)
    expect(bindings.some((b) => b.command === 'editor_view:cut_word_right')).toBe(false)
    expect(problems.some((p) => p.message.includes('meta'))).toBe(true)
  })

  it('turns an unreadable line into a problem, not a failed file', () => {
    const { bindings, problems } = parsed(POPULATED)
    expect(bindings.length).toBeGreaterThan(5)
    expect(problems.some((p) => p.detail === 'this line is not an entry at all')).toBe(true)
  })

  it('reads every spelling of an unbind as a chordless negated binding', () => {
    const { bindings } = parsed(UNBOUND)
    for (const command of [
      'terminal:copy',
      'terminal:paste',
      'editor_view:select_all',
      'workspace:new_tab'
    ]) {
      const binding = bindings.find((b) => b.command === command)
      expect(binding, `${command} is missing`).toBeDefined()
      expect(binding!.chord).toBeNull()
      expect(binding!.negated).toBe(true)
    }
    expect(chordFor(UNBOUND, 'pane_group:add_right')).toBe('cmd+d')
  })

  it('spoils only the entry it cannot read when the YAML gets ambitious', () => {
    const { bindings, problems } = parsed(NESTED)
    expect(bindings.map((b) => b.command)).toEqual(['terminal:copy', 'terminal:find'])
    // The nested map's head and its two children, plus an anchor, an alias and
    // a flow mapping.
    expect(problems).toHaveLength(6)
    expect(problems.some((p) => p.message.includes('Nested maps'))).toBe(true)
    expect(problems.some((p) => p.message.includes('an anchor'))).toBe(true)
    expect(problems.some((p) => p.message.includes('an alias'))).toBe(true)
    expect(problems.some((p) => p.message.includes('a flow mapping'))).toBe(true)
  })

  it('fails on a file that is no keybindings map at all', () => {
    const outcome = warpAdapter.parse(NOT_A_MAP)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/keybindings map/)
  })

  it('does not mistake an empty or comment-only file for an unreadable one', () => {
    expect(warpAdapter.parse('').ok).toBe(true)
    expect(warpAdapter.parse(warpAdapter.emptyContents()).ok).toBe(true)
    const { bindings, problems } = parsed('---\n# nothing bound yet\n\n')
    expect(bindings).toEqual([])
    expect(problems).toEqual([])
  })

  it('reports a binding it cannot decode instead of dropping it silently', () => {
    const { bindings, problems } = parsed('"terminal:copy": cmd-nonsense\n')
    expect(bindings).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0].detail).toBe('"terminal:copy": cmd-nonsense')
  })
})

describe('chord translation', () => {
  const cases: Array<[string, string]> = [
    ['cmd-d', 'cmd+d'],
    ['shift-cmd-D', 'shift+cmd+d'],
    ['alt-cmd-left', 'alt+cmd+left'],
    ['ctrl-shift-up', 'ctrl+shift+up'],
    ['alt-shift-cmd-C', 'alt+shift+cmd+c'],
    ['cmd--', 'cmd+-'],
    ['cmd-=', 'cmd+='],
    ['cmd-[', 'cmd+['],
    ['shift-cmd-}', 'shift+cmd+]'],
    ['shift-cmd-{', 'shift+cmd+['],
    ['ctrl-shift-?', 'ctrl+shift+/'],
    ['ctrl-`', 'ctrl+`'],
    ['shift-cmd-enter', 'shift+cmd+enter'],
    ['cmd-backspace', 'cmd+backspace'],
    ['shift-up', 'shift+up'],
    ['cmd-1', 'cmd+1'],
    ['alt-f12', 'alt+f12'],
    ['cmd-numpadenter', 'cmd+enter']
  ]

  for (const [warp, canonical] of cases) {
    it(`decodes ${warp}`, () => {
      const decoded = warpAdapter.decodeChord(warp)
      expect(decoded && formatCanonical(decoded)).toBe(canonical)
    })
  }

  it('takes a shifted character to mean shift even when shift is not written out', () => {
    expect(formatCanonical(warpAdapter.decodeChord('cmd-K')!)).toBe('shift+cmd+k')
    expect(formatCanonical(warpAdapter.decodeChord('cmd-}')!)).toBe('shift+cmd+]')
  })

  it('spells shift into the key when encoding, the way Warp writes it', () => {
    expect(warpAdapter.encodeChord(chord(stroke('k', 'cmd', 'shift')))).toEqual({
      ok: true,
      value: 'shift-cmd-K'
    })
    expect(warpAdapter.encodeChord(chord(stroke(']', 'cmd', 'shift')))).toEqual({
      ok: true,
      value: 'shift-cmd-}'
    })
    // A non-printing key has no shifted character, so it keeps its name.
    expect(warpAdapter.encodeChord(chord(stroke('up', 'ctrl', 'shift')))).toEqual({
      ok: true,
      value: 'ctrl-shift-up'
    })
  })

  it('orders modifiers the way Warp’s own keyset does', () => {
    expect(warpAdapter.encodeChord(chord(stroke('c', 'cmd', 'shift', 'alt')))).toEqual({
      ok: true,
      value: 'alt-shift-cmd-C'
    })
  })

  it('round-trips every encodable chord back to itself', () => {
    const samples = [
      chord(stroke('d', 'cmd')),
      chord(stroke('d', 'cmd', 'shift')),
      chord(stroke('-', 'cmd')),
      chord(stroke('`', 'ctrl')),
      chord(stroke('/', 'ctrl', 'shift')),
      chord(stroke('left', 'alt', 'cmd')),
      chord(stroke('f13')),
      chord(stroke('enter', 'shift', 'cmd'))
    ]
    for (const c of samples) {
      const encoded = warpAdapter.encodeChord(c)
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) continue
      expect(formatCanonical(warpAdapter.decodeChord(encoded.value)!)).toBe(formatCanonical(c))
    }
  })

  it('refuses `meta`, which is not cmd and not alt', () => {
    expect(warpAdapter.decodeChord('meta-d')).toBeNull()
    expect(warpAdapter.decodeChord('shift-meta-B')).toBeNull()
    // The canonical model aliases `meta` to cmd; conflating the two here would
    // claim these are the same binding.
    expect(warpAdapter.decodeChord('cmd-d')).not.toBeNull()
  })

  it('refuses the space bar in both directions rather than guessing in one', () => {
    expect(warpAdapter.decodeChord('cmd-space')).toBeNull()
    const encoded = warpAdapter.encodeChord(chord(stroke('space', 'cmd')))
    expect(encoded.ok).toBe(false)
    if (encoded.ok) return
    expect(encoded.reason).toMatch(/space/)
  })

  it('refuses what Warp cannot express', () => {
    expect(warpAdapter.encodeChord({ strokes: [] }).ok).toBe(false)
    expect(warpAdapter.encodeChord({ strokes: [{ modifiers: [], key: 'eject' }] }).ok).toBe(false)
    expect(warpAdapter.decodeChord('')).toBeNull()
    expect(warpAdapter.decodeChord('hyper-a')).toBeNull()
  })

  it('names the sequence it cannot write when refusing a two-keystroke chord', () => {
    const outcome = warpAdapter.encodeChord(chord(stroke('k', 'cmd'), stroke('s', 'cmd')))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('cmd+k cmd+s')
    expect(outcome.reason).toMatch(/sequence/)
  })
})

describe('merge', () => {
  for (const [name, contents] of FIXTURES) {
    it(`round-trips ${name} byte-identically`, () => {
      expect(merged(contents, []).contents).toBe(contents)
    })
  }

  it('round-trips byte-identically when the managed bindings are already correct', () => {
    const managed: ManagedBinding[] = [
      { command: 'terminal:copy', chord: chord(stroke('c', 'cmd')) },
      { command: 'terminal:paste', chord: chord(stroke('v', 'cmd')) },
      { command: 'pane_group:add_down', chord: chord(stroke('d', 'cmd', 'shift')) },
      { command: 'workspace:new_tab', chord: chord(stroke('t', 'cmd')) },
      { command: 'pane_group:navigate_right', chord: chord(stroke('right', 'alt', 'cmd')) }
    ]
    expect(merged(POPULATED, managed).contents).toBe(POPULATED)
  })

  it('leaves a differently-spelled but equivalent binding alone', () => {
    // `cmd-K` and `shift-cmd-K` are the same keystroke; rewriting one into the
    // other would churn a line the user did not ask us to touch.
    const base = '"editor_view:clear_lines": cmd-K\n'
    const out = merged(base, [
      { command: 'editor_view:clear_lines', chord: chord(stroke('k', 'cmd', 'shift')) }
    ]).contents
    expect(out).toBe(base)
  })

  it('preserves CRLF line endings and the absence of a trailing newline', () => {
    const crlf = '---\r\n# c\r\n"terminal:copy": cmd-c'
    expect(merged(crlf, []).contents).toBe(crlf)
    const changed = merged(crlf, [
      { command: 'terminal:copy', chord: chord(stroke('x', 'cmd', 'shift')) }
    ])
    expect(changed.contents).toBe('---\r\n# c\r\n"terminal:copy": shift-cmd-X')
  })

  it('rewrites a managed entry in place, keeping its quoting and spacing', () => {
    const out = merged(POPULATED, [
      { command: 'terminal:paste', chord: chord(stroke('b', 'cmd')) },
      { command: 'workspace:new_tab', chord: chord(stroke('n', 'cmd')) }
    ]).contents
    // The single-quoted value stays single-quoted, the wide separator stays wide.
    expect(out).toContain("'terminal:paste': 'cmd-b'")
    expect(out).toContain('"workspace:new_tab":   cmd-n')
  })

  it('leaves every unmanaged line untouched, including ordering and comments', () => {
    const out = merged(POPULATED, [
      { command: 'pane_group:add_right', chord: chord(stroke('e', 'cmd')) }
    ]).contents
    const changedLines = POPULATED.split('\n').filter((line, i) => out.split('\n')[i] !== line)
    expect(changedLines).toEqual(['"pane_group:add_right": cmd-d'])
  })

  it('never destroys the nested YAML it cannot read', () => {
    const out = merged(NESTED, [
      { command: 'terminal:copy', chord: chord(stroke('y', 'cmd')) },
      { command: 'workspace:new_tab', chord: chord(stroke('t', 'cmd')) }
    ]).contents
    expect(out).toContain('keybindings:')
    expect(out).toContain('  "terminal:paste": cmd-v')
    expect(out).toContain('"pane_group:add_right": &split cmd-d')
    // The flow-style entry is a top-level entry for this action, so it is the
    // one rewritten rather than a second line being appended.
    expect(out).toContain('"workspace:new_tab": cmd-t')
    expect(out).not.toContain('{ key: cmd-t }')
  })

  it('appends a new binding under a managed section', () => {
    const out = merged(NO_TRAILING_NEWLINE, [
      { command: 'terminal:find', chord: chord(stroke('f', 'cmd')) }
    ]).contents
    expect(out).toBe(`${NO_TRAILING_NEWLINE}\n\n# Managed by unikeys\n"terminal:find": cmd-f`)
  })

  it('extends the existing managed section rather than starting a second one', () => {
    const base = '# Managed by unikeys\n"terminal:copy": cmd-c\n'
    const out = merged(base, [
      { command: 'terminal:paste', chord: chord(stroke('v', 'cmd')) }
    ]).contents
    expect(out).toBe('# Managed by unikeys\n"terminal:copy": cmd-c\n"terminal:paste": cmd-v\n')
  })

  it('matches the file’s dominant key-quoting style when appending', () => {
    const bare = 'terminal:copy: cmd-c\nterminal:paste: cmd-v\n'
    const out = merged(bare, [
      { command: 'pane_group:add_right', chord: chord(stroke('d', 'cmd')) }
    ]).contents
    expect(out).toContain('pane_group:add_right: cmd-d')
    expect(out).not.toContain('"pane_group:add_right"')
  })

  it('quotes a value a bare scalar would misread', () => {
    // A leading backtick is a reserved YAML indicator, so written bare it would
    // not read back as the binding we wrote.
    const out = merged('# Managed by unikeys\n', [
      { command: 'terminal:copy', chord: chord(stroke('`')) }
    ]).contents
    expect(out).toContain('"terminal:copy": "`"')
    expect(chordFor(out, 'terminal:copy')).toBe('`')
  })

  it('collapses duplicate entries for a managed action onto one', () => {
    const base = '"terminal:copy": cmd-c\n# mine\n"terminal:copy": cmd-y\n'
    const out = merged(base, [
      { command: 'terminal:copy', chord: chord(stroke('z', 'cmd')) }
    ]).contents
    expect(out.match(/terminal:copy/g)).toHaveLength(1)
    expect(out).toContain('"terminal:copy": cmd-z')
    // The comment above the removed line is not ours to delete.
    expect(out).toContain('# mine')
  })

  it('writes an empty value when a managed action with a Warp default is cleared', () => {
    const base = '"terminal:copy": cmd-j\n'
    const out = merged(base, [{ command: 'terminal:copy', chord: null }]).contents
    expect(out).toBe('"terminal:copy":\n')
    expect(parsed(out).bindings[0].negated).toBe(true)
  })

  it('adds the unbind when the file never mentioned the action', () => {
    const base = '"pane_group:add_right": cmd-d\n'
    const out = merged(base, [{ command: 'terminal:copy', chord: null }]).contents
    expect(out).toBe('"pane_group:add_right": cmd-d\n\n# Managed by unikeys\n"terminal:copy":\n')
  })

  it('just removes the entry when the action has no Warp default to resurface', () => {
    const base = '"custom:invented_action": cmd-j\n'
    const out = merged(base, [{ command: 'custom:invented_action', chord: null }]).contents
    expect(out).toBe('')
  })

  it('does not rewrite an action that is already unbound', () => {
    const base = '"terminal:copy":\n'
    expect(merged(base, [{ command: 'terminal:copy', chord: null }]).contents).toBe(base)
  })

  it('binds an action back after it was unbound', () => {
    const base = '"terminal:copy":\n'
    const out = merged(base, [
      { command: 'terminal:copy', chord: chord(stroke('c', 'cmd')) }
    ]).contents
    expect(out).toBe('"terminal:copy": cmd-c\n')
  })

  it('reports inexpressible chords rather than dropping them', () => {
    const outcome = merged(POPULATED, [
      { command: 'terminal:copy', chord: chord(stroke('k', 'cmd'), stroke('s', 'cmd')) },
      { command: 'pane_group:add_right', chord: chord(stroke('e', 'cmd')) }
    ])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('terminal:copy')
    expect(outcome.skipped[0].reason).toMatch(/sequence/)
    // A skipped chord must not have half-written the file.
    expect(outcome.contents).toContain('"terminal:copy": "cmd-c"')
    expect(outcome.contents).toContain('"pane_group:add_right": cmd-e')
  })

  it('merges into freshly created empty contents', () => {
    const empty = warpAdapter.emptyContents()
    expect(merged(empty, []).contents).toBe(empty)
    const out = merged(empty, [
      { command: 'workspace:new_tab', chord: chord(stroke('t', 'cmd')) }
    ]).contents
    expect(out).toBe(
      '---\n# Warp keybindings\n\n# Managed by unikeys\n"workspace:new_tab": cmd-t\n'
    )
    expect(chordFor(out, 'workspace:new_tab')).toBe('cmd+t')
  })

  it('writes changes that parse back to what was asked for', () => {
    const managed: ManagedBinding[] = [
      { command: 'pane_group:add_right', chord: chord(stroke(']', 'cmd', 'alt')) },
      { command: 'terminal:copy', chord: chord(stroke('c', 'ctrl', 'shift')) },
      { command: 'input:clear_screen', chord: chord(stroke('l', 'cmd')) }
    ]
    const out = merged(POPULATED, managed).contents
    expect(chordFor(out, 'pane_group:add_right')).toBe('alt+cmd+]')
    expect(chordFor(out, 'terminal:copy')).toBe('ctrl+shift+c')
    expect(chordFor(out, 'input:clear_screen')).toBe('cmd+l')
  })
})

describe('defaults', () => {
  const report = warpAdapter.defaults('warp')
  const byCommand = new Map(report.bindings.map((b) => [b.command, formatCanonical(b.chord!)]))

  it('is sourced from Warp’s published keyset but reports itself as partial', () => {
    expect(report.availability).toBe('partial')
    expect(report.note).toMatch(/keysets/)
    expect(report.note).toMatch(/meta/)
    expect(report.bindings.length).toBeGreaterThan(90)
    expect(report.bindings.every((b) => b.source === 'default')).toBe(true)
  })

  it('encodes the defaults it claims', () => {
    expect(byCommand.get('pane_group:add_right')).toBe('cmd+d')
    expect(byCommand.get('pane_group:add_down')).toBe('shift+cmd+d')
    expect(byCommand.get('pane_group:navigate_left')).toBe('alt+cmd+left')
    expect(byCommand.get('pane_group:navigate_next')).toBe('cmd+]')
    expect(byCommand.get('pane_group:navigate_prev')).toBe('cmd+[')
    expect(byCommand.get('terminal:copy')).toBe('cmd+c')
    expect(byCommand.get('terminal:paste')).toBe('cmd+v')
    expect(byCommand.get('workspace:activate_next_tab')).toBe('shift+cmd+]')
    expect(byCommand.get('workspace:activate_prev_tab')).toBe('shift+cmd+[')
    expect(byCommand.get('workspace:increase_font_size')).toBe('cmd+=')
    expect(byCommand.get('workspace:decrease_font_size')).toBe('cmd+-')
    expect(byCommand.get('workspace:reset_font_size')).toBe('cmd+0')
    expect(byCommand.get('workspace:toggle_command_palette')).toBe('cmd+p')
    expect(byCommand.get('workspace:new_tab')).toBe('cmd+t')
    expect(byCommand.get('input:clear_screen')).toBe('ctrl+l')
    expect(byCommand.get('terminal:select_all_blocks')).toBe('cmd+a')
  })

  it('leaves out the entries whose modifier it refuses rather than approximating them', () => {
    expect(byCommand.has('editor_view:cut_word_right')).toBe(false)
    expect(byCommand.has('editor_view:move_backward_one_word')).toBe(false)
  })

  it('claims nothing for apps it does not serve', () => {
    const other = warpAdapter.defaults('ghostty')
    expect(other.availability).toBe('unavailable')
    expect(other.bindings).toEqual([])
  })
})

describe('the Warp catalogue fragment', () => {
  const commands: Record<string, string> = warpCommands
  const catalogueIds = new Set(catalogueData.actions.map((action) => action.id))

  it('names only actions that exist in the shipped catalogue', () => {
    for (const id of Object.keys(commands)) {
      expect(catalogueIds.has(id), `${id} is not a catalogue action`).toBe(true)
    }
  })

  it('names only Warp actions the adapter knows', () => {
    for (const [id, command] of Object.entries(commands)) {
      expect(WARP_ACTION_IDS.has(command), `${id} maps unknown Warp action "${command}"`).toBe(true)
    }
  })

  it('covers the terminal and window rows Warp really has', () => {
    expect(commands['pane.split-right']).toBe('pane_group:add_right')
    expect(commands['pane.focus-up']).toBe('pane_group:navigate_up')
    expect(commands['edit.copy']).toBe('terminal:copy')
    expect(commands['terminal.new']).toBe('workspace:new_tab')
    // Warp binds cmd-a to both `terminal:select_all_blocks` and
    // `editor_view:select_all`. The row takes the first because its peers —
    // Ghostty's `select_all`, iTerm2's `menu:select-all` — select the
    // terminal's contents, not the command input's.
    expect(commands['edit.select-all']).toBe('terminal:select_all_blocks')
    expect(Object.keys(commands).length).toBeGreaterThanOrEqual(15)
  })

  it('omits rather than invents the rows Warp has no action for', () => {
    // Warp exposes no rebindable New Window, Close Tab or Toggle Full Screen,
    // and none of the editor rows. An absent key renders as not-applicable.
    for (const id of [
      'window.new-window',
      'window.close',
      'window.toggle-fullscreen',
      'terminal.reload-config',
      'edit.save',
      'edit.rename-symbol',
      'navigate.goto-definition'
    ]) {
      expect(commands[id], `${id} should not be mapped`).toBeUndefined()
    }
  })
})
