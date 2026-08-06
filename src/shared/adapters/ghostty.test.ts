import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, stroke } from '../chord'
import type { ManagedBinding, MergeOutcome, ParseOutcome } from './types'
import { ghosttyAdapter, ghosttyClearsDefaults } from './ghostty'

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/ghostty/${name}`, import.meta.url)),
    'utf8'
  )
}

const FULL = fixture('full.conf')
const NO_TRAILING_NEWLINE = fixture('no-trailing-newline.conf')

function parsed(contents: string): Extract<ParseOutcome, { ok: true }> {
  const outcome = ghosttyAdapter.parse(contents)
  if (!outcome.ok) throw new Error(`expected parse to succeed: ${outcome.error}`)
  return outcome
}

function merged(contents: string, managed: ManagedBinding[]): Extract<MergeOutcome, { ok: true }> {
  const outcome = ghosttyAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`expected merge to succeed: ${outcome.error}`)
  return outcome
}

function chordFor(contents: string, command: string): string | null {
  const binding = parsed(contents).bindings.find((b) => b.command === command)
  return binding?.chord ? formatCanonical(binding.chord) : null
}

describe('parse', () => {
  it('reads bindings from a real-shaped config regardless of spacing', () => {
    const { bindings } = parsed(FULL)
    expect(chordFor(FULL, 'new_split:right')).toBe('shift+cmd+d')
    expect(chordFor(FULL, 'new_split:down')).toBe('cmd+d')
    // `keybind=cmd+w=close_surface` — no spaces at all.
    expect(chordFor(FULL, 'close_surface')).toBe('cmd+w')
    expect(bindings.some((b) => b.command === 'goto_split:left')).toBe(true)
  })

  it('keeps the whole action, including colons and equals signs', () => {
    expect(chordFor(FULL, 'text:x=1')).toBe('shift+cmd+h')
  })

  it('reads a leader sequence as a two-stroke chord', () => {
    const { bindings } = parsed('keybind = ctrl+a>n=new_tab\n')
    expect(formatCanonical(bindings[0].chord!)).toBe('ctrl+a n')
  })

  it('records an unbind as a negated binding for the action the trigger defaults to', () => {
    const clearScreen = parsed(FULL).bindings.find((b) => b.command === 'clear_screen')
    expect(clearScreen?.negated).toBe(true)
    expect(formatCanonical(clearScreen!.chord!)).toBe('cmd+k')
  })

  it('reports rather than misreads a trigger prefix it does not model', () => {
    const { bindings, problems } = parsed(FULL)
    expect(bindings.some((b) => b.command === 'toggle_quick_terminal')).toBe(false)
    expect(problems.some((p) => p.detail?.includes('global:'))).toBe(true)
  })

  it('reports sequences longer than two keystrokes instead of truncating them', () => {
    const { bindings, problems } = parsed('keybind = ctrl+a>b>c=new_tab\n')
    expect(bindings).toEqual([])
    expect(problems).toHaveLength(1)
  })

  it('turns unreadable lines into problems, never a whole-file failure', () => {
    const { bindings, problems } = parsed(FULL)
    expect(bindings.length).toBeGreaterThan(5)
    expect(problems.some((p) => p.detail === 'this line is not a setting at all')).toBe(true)
  })

  it('survives a file of pure noise', () => {
    const outcome = ghosttyAdapter.parse('!!!\n\x00\nkeybind =\n')
    expect(outcome.ok).toBe(true)
  })

  it('ignores comments, blank lines and non-keybind settings', () => {
    const { bindings, problems } = parsed('# hi\n\nfont-size = 13\ntheme = x\n')
    expect(bindings).toEqual([])
    expect(problems).toEqual([])
  })

  it('surfaces `keybind = clear` as an advisory rather than a binding', () => {
    const { bindings, problems } = parsed(FULL)
    expect(bindings.some((b) => b.command === 'clear')).toBe(false)
    expect(problems.some((p) => p.detail === 'keybind = clear')).toBe(true)
    expect(ghosttyClearsDefaults(FULL)).toBe(true)
    expect(ghosttyClearsDefaults(NO_TRAILING_NEWLINE)).toBe(false)
  })
})

describe('chord translation', () => {
  const cases: Array<[string, string]> = [
    ['cmd+shift+d', 'shift+cmd+d'],
    ['ctrl+a', 'ctrl+a'],
    ['super+alt+left', 'alt+cmd+left'],
    ['cmd+grave_accent', 'cmd+`'],
    ['cmd+left_bracket', 'cmd+['],
    ['shift+page_up', 'shift+pageup'],
    ['cmd+minus', 'cmd+-'],
    ['cmd+equal', 'cmd+='],
    ['option+f12', 'alt+f12'],
    ['ctrl+a>n', 'ctrl+a n']
  ]

  for (const [ghostty, canonical] of cases) {
    it(`decodes ${ghostty}`, () => {
      const decoded = ghosttyAdapter.decodeChord(ghostty)
      expect(decoded && formatCanonical(decoded)).toBe(canonical)
    })
  }

  it('accepts literal punctuation as well as the word forms', () => {
    expect(formatCanonical(ghosttyAdapter.decodeChord('cmd+,')!)).toBe('cmd+,')
    expect(formatCanonical(ghosttyAdapter.decodeChord('cmd+comma')!)).toBe('cmd+,')
  })

  it('encodes back to Ghostty notation', () => {
    expect(ghosttyAdapter.encodeChord(chord(stroke('d', 'cmd', 'shift')))).toEqual({
      ok: true,
      value: 'shift+cmd+d'
    })
    expect(ghosttyAdapter.encodeChord(chord(stroke('[', 'cmd')))).toEqual({
      ok: true,
      value: 'cmd+left_bracket'
    })
    expect(ghosttyAdapter.encodeChord(chord(stroke('pageup', 'shift')))).toEqual({
      ok: true,
      value: 'shift+page_up'
    })
  })

  it('encodes a two-stroke chord as a leader sequence', () => {
    expect(ghosttyAdapter.encodeChord(chord(stroke('a', 'ctrl'), stroke('n')))).toEqual({
      ok: true,
      value: 'ctrl+a>n'
    })
  })

  it('round-trips every encodable chord back to itself', () => {
    const samples = [
      chord(stroke('d', 'cmd', 'shift')),
      chord(stroke('`', 'ctrl', 'alt')),
      chord(stroke('f5')),
      chord(stroke('a', 'ctrl'), stroke('n', 'cmd'))
    ]
    for (const c of samples) {
      const encoded = ghosttyAdapter.encodeChord(c)
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) continue
      expect(formatCanonical(ghosttyAdapter.decodeChord(encoded.value)!)).toBe(formatCanonical(c))
    }
  })

  it('refuses what Ghostty cannot express', () => {
    expect(ghosttyAdapter.encodeChord({ strokes: [] }).ok).toBe(false)
    expect(ghosttyAdapter.encodeChord(chord(stroke('a'), stroke('b'), stroke('c'))).ok).toBe(false)
    expect(ghosttyAdapter.encodeChord({ strokes: [{ modifiers: [], key: 'eject' }] }).ok).toBe(
      false
    )
  })

  it('returns null for triggers it cannot represent', () => {
    expect(ghosttyAdapter.decodeChord('global:cmd+a')).toBeNull()
    expect(ghosttyAdapter.decodeChord('cmd+nonsense')).toBeNull()
    expect(ghosttyAdapter.decodeChord('')).toBeNull()
  })
})

describe('merge', () => {
  it('round-trips unchanged content byte-identically', () => {
    expect(merged(FULL, []).contents).toBe(FULL)
    expect(merged(NO_TRAILING_NEWLINE, []).contents).toBe(NO_TRAILING_NEWLINE)
  })

  it('round-trips byte-identically when the managed bindings are already correct', () => {
    const managed: ManagedBinding[] = [
      { command: 'new_split:down', chord: chord(stroke('d', 'cmd')) },
      { command: 'close_surface', chord: chord(stroke('w', 'cmd')) }
    ]
    expect(merged(FULL, managed).contents).toBe(FULL)
  })

  it('preserves CRLF line endings and the absence of a trailing newline', () => {
    const crlf = '# c\r\nfont-size = 13\r\nkeybind = cmd+t=new_tab'
    expect(merged(crlf, []).contents).toBe(crlf)
    const changed = merged(crlf, [
      { command: 'new_tab', chord: chord(stroke('t', 'ctrl', 'shift')) }
    ])
    expect(changed.contents).toBe('# c\r\nfont-size = 13\r\nkeybind = ctrl+shift+t=new_tab')
  })

  it('rewrites a managed line in place, keeping its own spacing style', () => {
    const out = merged(FULL, [
      { command: 'close_surface', chord: chord(stroke('q', 'cmd', 'shift')) }
    ]).contents
    expect(out).toContain('keybind=shift+cmd+q=close_surface')
    expect(out).not.toContain('cmd+w=close_surface')
  })

  it('leaves every unmanaged line untouched, including ordering and comments', () => {
    const out = merged(FULL, [
      { command: 'new_split:down', chord: chord(stroke('e', 'cmd')) }
    ]).contents
    const changedLines = FULL.split('\n').filter((line, i) => out.split('\n')[i] !== line)
    expect(changedLines).toEqual(['keybind = cmd+d=new_split:down'])
  })

  it('never destroys `keybind = clear`', () => {
    const out = merged(FULL, [
      { command: 'new_split:down', chord: chord(stroke('e', 'cmd')) },
      { command: 'close_surface', chord: null },
      { command: 'something_new', chord: chord(stroke('j', 'cmd')) }
    ]).contents
    expect(out).toContain('keybind = clear')
  })

  it('appends a new binding under a managed section', () => {
    const out = merged(NO_TRAILING_NEWLINE, [
      { command: 'toggle_fullscreen', chord: chord(stroke('enter', 'cmd')) }
    ]).contents
    expect(out).toBe(
      `${NO_TRAILING_NEWLINE}\n\n# Managed by unikeys\nkeybind = cmd+enter=toggle_fullscreen`
    )
  })

  it('extends the existing managed section rather than starting a second one', () => {
    const base = '# Managed by unikeys\nkeybind = cmd+n=new_window\n'
    const out = merged(base, [{ command: 'new_tab', chord: chord(stroke('t', 'cmd')) }]).contents
    expect(out).toBe('# Managed by unikeys\nkeybind = cmd+n=new_window\nkeybind = cmd+t=new_tab\n')
  })

  it('matches the file dominant spacing style when appending', () => {
    const tight = 'keybind=cmd+n=new_window\nkeybind=cmd+w=close_surface\n'
    const out = merged(tight, [{ command: 'new_tab', chord: chord(stroke('t', 'cmd')) }]).contents
    expect(out).toContain('keybind=cmd+t=new_tab')
  })

  it('collapses duplicate lines for a managed action onto one', () => {
    const out = merged(FULL, [{ command: 'new_tab', chord: chord(stroke('t', 'cmd')) }]).contents
    expect(out.match(/=new_tab/g)).toHaveLength(1)
    expect(out).toContain('keybind = cmd+t=new_tab')
    // The comment above the removed sequence line is not ours to delete.
    expect(out).toContain('# A leader sequence: ctrl+a then n')
  })

  it('unbinds a default trigger when a managed action is cleared', () => {
    const base = 'keybind = cmd+j=new_tab\n'
    const out = merged(base, [{ command: 'new_tab', chord: null }]).contents
    expect(out).not.toContain('cmd+j')
    expect(out).toContain('keybind = cmd+t=unbind')
  })

  it('just removes the line when the action has no Ghostty default to resurface', () => {
    const base = 'keybind = cmd+j=some_custom_action\n'
    const out = merged(base, [{ command: 'some_custom_action', chord: null }]).contents
    expect(out).toBe('')
  })

  it('removes a stale unbind when the action is bound again', () => {
    const base = 'font-size = 13\nkeybind = cmd+k=unbind\n'
    const out = merged(base, [
      { command: 'clear_screen', chord: chord(stroke('l', 'cmd')) }
    ]).contents
    expect(out).not.toContain('unbind')
    expect(out).toContain('keybind = cmd+l=clear_screen')
    expect(out).toContain('font-size = 13')
  })

  it('does not write a second unbind for an action already suppressed', () => {
    const base = 'keybind = cmd+k=unbind\n'
    const out = merged(base, [{ command: 'clear_screen', chord: null }]).contents
    expect(out).toBe(base)
  })

  it('reports inexpressible chords rather than dropping them', () => {
    const outcome = merged(FULL, [
      { command: 'new_tab', chord: { strokes: [{ modifiers: ['cmd'], key: 'eject' }] } }
    ])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('new_tab')
    expect(outcome.skipped[0].reason).toMatch(/eject/)
    // A skipped chord must not have half-written the file.
    expect(outcome.contents).toContain('keybind = ctrl+shift+t=new_tab')
  })

  it('merges into freshly created empty contents', () => {
    const empty = ghosttyAdapter.emptyContents()
    expect(merged(empty, []).contents).toBe(empty)
    const out = merged(empty, [{ command: 'new_tab', chord: chord(stroke('t', 'cmd')) }]).contents
    expect(out).toBe('# Ghostty configuration\n\n# Managed by unikeys\nkeybind = cmd+t=new_tab\n')
    expect(chordFor(out, 'new_tab')).toBe('cmd+t')
  })

  it('writes changes that parse back to what was asked for', () => {
    const managed: ManagedBinding[] = [
      { command: 'new_split:right', chord: chord(stroke(']', 'cmd', 'alt')) },
      { command: 'reload_config', chord: chord(stroke('r', 'cmd'), stroke('r')) }
    ]
    const out = merged(FULL, managed).contents
    expect(chordFor(out, 'new_split:right')).toBe('alt+cmd+]')
    expect(chordFor(out, 'reload_config')).toBe('cmd+r r')
  })
})

describe('defaults', () => {
  it('offers a partial, clearly-labelled table of transcribed defaults', () => {
    const report = ghosttyAdapter.defaults('ghostty')
    expect(report.availability).toBe('partial')
    expect(report.note).toMatch(/documentation/)
    expect(report.bindings.length).toBeGreaterThan(15)
    expect(report.bindings.every((b) => b.source === 'default')).toBe(true)
  })

  it('encodes the defaults it claims', () => {
    const report = ghosttyAdapter.defaults('ghostty')
    const byCommand = new Map(report.bindings.map((b) => [b.command, formatCanonical(b.chord!)]))
    expect(byCommand.get('new_tab')).toBe('cmd+t')
    expect(byCommand.get('new_split:right')).toBe('cmd+d')
    expect(byCommand.get('new_split:down')).toBe('shift+cmd+d')
    expect(byCommand.get('goto_split:left')).toBe('alt+cmd+left')
    expect(byCommand.get('reset_font_size')).toBe('cmd+0')
    expect(byCommand.get('toggle_fullscreen')).toBe('ctrl+cmd+f')
  })

  it('claims nothing for apps it does not serve', () => {
    const report = ghosttyAdapter.defaults('vscode')
    expect(report.availability).toBe('unavailable')
    expect(report.bindings).toEqual([])
  })
})
