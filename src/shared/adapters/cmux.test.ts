import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, parseCanonical, stroke } from '../chord'
import { cmuxAdapter } from './cmux'
import type { ManagedBinding, MergeOutcome, ParseOutcome, ParsedBinding } from './types'

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/cmux/${name}`, import.meta.url)),
    'utf8'
  )
}

/** The config cmux 0.64.22 writes itself: no `shortcuts`, everything else a comment. */
const TEMPLATE = fixture('template-0.64.22.jsonc')
const POPULATED = fixture('populated.jsonc')
const SHORTCUTS_ONLY = fixture('shortcuts-no-bindings.jsonc')
const MALFORMED = fixture('malformed.jsonc')

function parsed(contents: string): Extract<ParseOutcome, { ok: true }> {
  const outcome = cmuxAdapter.parse(contents)
  if (!outcome.ok) throw new Error(`expected parse to succeed: ${outcome.error}`)
  return outcome
}

function merged(contents: string, managed: ManagedBinding[]): Extract<MergeOutcome, { ok: true }> {
  const outcome = cmuxAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`expected merge to succeed: ${outcome.error}`)
  return outcome
}

function bindingFor(contents: string, command: string): ParsedBinding | undefined {
  return parsed(contents).bindings.find((b) => b.command === command)
}

function chordFor(contents: string, command: string): string | null {
  const binding = bindingFor(contents, command)
  return binding?.chord ? formatCanonical(binding.chord) : null
}

function encoded(text: string): string {
  const parsedChord = parseCanonical(text)
  if (parsedChord === null) throw new Error(`test wrote an unparseable chord: ${text}`)
  const outcome = cmuxAdapter.encodeChord(parsedChord)
  if (!outcome.ok) throw new Error(`expected encode to succeed: ${outcome.reason}`)
  return outcome.value
}

function canonical(text: string): string | null {
  const decoded = cmuxAdapter.decodeChord(text)
  return decoded === null ? null : formatCanonical(decoded)
}

/** A managed binding whose command is real but whose chord is one cmux cannot write. */
function managed(command: string, text: string | null): ManagedBinding {
  return { command, chord: text === null ? null : parseCanonical(text) }
}

describe('identity', () => {
  it('serves cmux alone', () => {
    expect(cmuxAdapter.format).toBe('cmux-config')
    expect(cmuxAdapter.apps).toEqual(['cmux'])
  })
})

describe('parse', () => {
  it('reads the config cmux generates as overriding nothing', () => {
    // Every setting in the generated template is commented out, so there is no
    // `shortcuts` member at all. That is an untouched config, not a broken one.
    const outcome = parsed(TEMPLATE)
    expect(outcome.bindings).toEqual([])
    expect(outcome.problems).toEqual([])
  })

  it('reads single-keystroke shortcuts', () => {
    expect(chordFor(POPULATED, 'commandPalette')).toBe('shift+cmd+p')
    expect(chordFor(POPULATED, 'splitRight')).toBe('cmd+d')
  })

  it("reads the arrow symbols cmux's own template writes", () => {
    expect(chordFor(POPULATED, 'focusLeft')).toBe('alt+cmd+left')
  })

  it('reads a two-keystroke chord written as an array', () => {
    expect(chordFor(POPULATED, 'newSurface')).toBe('ctrl+b c')
  })

  it('treats every unbind spelling as a deliberate unbind', () => {
    for (const command of ['sendFeedback', 'toggleSidebar', 'quit']) {
      const binding = bindingFor(POPULATED, command)
      expect(binding, `${command} should be read`).toBeDefined()
      expect(binding?.chord, `${command} should have no chord`).toBeNull()
      // Without this the cell would fall back to cmux's default and show a
      // chord the user has deliberately switched off.
      expect(binding?.negated, `${command} should be negated`).toBe(true)
    }
  })

  it('reports an unknown action id as a problem rather than a binding', () => {
    const outcome = parsed(POPULATED)
    expect(outcome.bindings.some((b) => b.command === 'notARealCmuxAction')).toBe(false)
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0].message).toContain('notARealCmuxAction')
  })

  it('never claims cmux defaults are suppressed', () => {
    // `bindings` overrides one action at a time; nothing in the format discards
    // the shipped defaults wholesale the way Ghostty's `keybind = clear` does.
    expect(parsed(POPULATED).defaultsSuppressed).toBeUndefined()
    expect(parsed(TEMPLATE).defaultsSuppressed).toBeUndefined()
  })

  it('reads a config with shortcuts but no bindings', () => {
    expect(parsed(SHORTCUTS_ONLY).bindings).toEqual([])
  })

  it('fails the whole file only for a syntax error', () => {
    const outcome = cmuxAdapter.parse(MALFORMED)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('not valid JSON')
  })

  it('reads an empty file as no bindings', () => {
    expect(parsed('').bindings).toEqual([])
  })
})

describe('encodeChord', () => {
  it('writes modifiers in the order the generated template uses', () => {
    expect(encoded('shift+cmd+p')).toBe('cmd+shift+p')
    expect(encoded('ctrl+cmd+u')).toBe('cmd+ctrl+u')
  })

  it('spells Option as opt, the way cmux does', () => {
    expect(encoded('alt+cmd+left')).toBe('cmd+opt+left')
  })

  it('spells Enter as return rather than the raw carriage return cmux emits', () => {
    expect(encoded('shift+cmd+enter')).toBe('cmd+shift+return')
  })

  it('writes letters, digits and punctuation literally', () => {
    expect(encoded('cmd+,')).toBe('cmd+,')
    expect(encoded('cmd+1')).toBe('cmd+1')
    expect(encoded('cmd+[')).toBe('cmd+[')
    expect(encoded('cmd+f12')).toBe('cmd+f12')
  })

  it('joins the keystrokes of a chord with a space', () => {
    expect(encoded('ctrl+b c')).toBe('ctrl+b c')
  })

  it('refuses keys cmux has no spelling for', () => {
    for (const key of ['escape', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown']) {
      const outcome = cmuxAdapter.encodeChord(chord(stroke(key, 'cmd')))
      expect(outcome.ok, `${key} should be inexpressible`).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toContain(key)
    }
  })

  it('refuses a first keystroke with no modifier', () => {
    // cmux requires one, so writing `"p"` would produce a file it rejects.
    const outcome = cmuxAdapter.encodeChord(chord(stroke('p')))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('modifier')
  })

  it('allows a bare Space as the first keystroke, which is the one exception', () => {
    expect(cmuxAdapter.encodeChord(chord(stroke('space')))).toEqual({ ok: true, value: 'space' })
  })

  it('allows a bare second keystroke', () => {
    expect(encoded('ctrl+b c')).toBe('ctrl+b c')
  })
})

describe('decodeChord', () => {
  it('accepts every modifier spelling in the schema', () => {
    for (const text of ['cmd+p', 'command+p', '⌘+p']) {
      expect(canonical(text), text).toBe('cmd+p')
    }
    for (const text of ['opt+p', 'option+p', 'alt+p', '⌥+p']) {
      expect(canonical(text), text).toBe('alt+p')
    }
    for (const text of ['ctrl+p', 'control+p', 'ctl+p', '⌃+p']) {
      expect(canonical(text), text).toBe('ctrl+p')
    }
  })

  it('accepts every arrow spelling', () => {
    for (const text of ['cmd+left', 'cmd+arrowleft', 'cmd+leftarrow', 'cmd+←']) {
      expect(canonical(text), text).toBe('cmd+left')
    }
  })

  it("accepts the raw carriage return cmux's template writes for Return", () => {
    // The template contains `"toggleSplitZoom": "cmd+shift+\r"`, so this is not
    // a hypothetical spelling — it is the one on disk.
    expect(canonical('cmd+shift+\r')).toBe('shift+cmd+enter')
    expect(canonical('cmd+shift+↩')).toBe('shift+cmd+enter')
    expect(canonical('cmd+shift+return')).toBe('shift+cmd+enter')
  })

  it('accepts both bracket spellings', () => {
    expect(canonical('cmd+leftbracket')).toBe('cmd+[')
    expect(canonical('cmd+openbracket')).toBe('cmd+[')
    expect(canonical('cmd+[')).toBe('cmd+[')
  })

  it('accepts the bare space key in both of its forms', () => {
    expect(canonical(' ')).toBe('space')
    expect(canonical('cmd+ ')).toBe('cmd+space')
    expect(canonical('cmd+<space>')).toBe('cmd+space')
  })

  it('is case-insensitive, as the schema is', () => {
    expect(canonical('CMD+Shift+P')).toBe('shift+cmd+p')
  })

  it('returns null for a media key rather than guessing', () => {
    expect(canonical('mediaplaypause')).toBeNull()
    expect(canonical('cmd+volumeup')).toBeNull()
  })

  it('round-trips everything it encodes', () => {
    for (const text of ['cmd+p', 'shift+cmd+enter', 'alt+cmd+left', 'ctrl+b c', 'cmd+,']) {
      expect(canonical(encoded(text)), text).toBe(text)
    }
  })
})

describe('merge', () => {
  it('leaves an untouched config byte-identical', () => {
    for (const contents of [TEMPLATE, POPULATED, SHORTCUTS_ONLY]) {
      expect(merged(contents, []).contents).toBe(contents)
    }
  })

  it('leaves an already-correct binding byte-identical', () => {
    expect(merged(POPULATED, [managed('commandPalette', 'shift+cmd+p')]).contents).toBe(POPULATED)
  })

  it('rewrites an existing binding in place', () => {
    const { contents } = merged(POPULATED, [managed('splitRight', 'shift+cmd+backslash')])
    expect(chordFor(contents, 'splitRight')).toBe('shift+cmd+\\')
    // Everything around the edited line survives untouched.
    expect(contents).toContain('"appearance": "system"')
    expect(contents).toContain('"showModifierHoldHints": true')
    expect(chordFor(contents, 'commandPalette')).toBe('shift+cmd+p')
  })

  it('adds a binding to a bindings object that already exists', () => {
    const { contents } = merged(POPULATED, [managed('find', 'cmd+f')])
    expect(chordFor(contents, 'find')).toBe('cmd+f')
    expect(contents).toContain('// Not one of the 142 ids cmux accepts.')
  })

  it('creates bindings inside a shortcuts object that lacks it', () => {
    const { contents } = merged(SHORTCUTS_ONLY, [managed('find', 'cmd+f')])
    expect(chordFor(contents, 'find')).toBe('cmd+f')
    // The sibling setting must survive rather than be replaced.
    expect(contents).toContain('"showModifierHoldHints": false')
  })

  it('creates the whole shortcuts block in the config cmux generates', () => {
    // The case almost every real machine hits on first save.
    const { contents } = merged(TEMPLATE, [
      managed('commandPalette', 'shift+cmd+k'),
      managed('splitRight', 'cmd+d')
    ])
    expect(chordFor(contents, 'commandPalette')).toBe('shift+cmd+k')
    expect(chordFor(contents, 'splitRight')).toBe('cmd+d')
    // The template is mostly comments, and every one of them is the point.
    expect(contents).toContain('// This file uses JSON with comments (JSONC).')
    expect(contents).toContain('//       "toggleFullScreen" : "cmd+ctrl+f"')
    expect(contents).toContain('"schemaVersion": 1')
  })

  it('writes the empty-string sentinel to unbind, and nothing else', () => {
    // `bindings` layers over cmux's defaults, so there is no shipped default to
    // negate separately the way VSCode and Ghostty both need.
    const { contents } = merged(POPULATED, [managed('splitRight', null)])
    expect(contents).toContain('"splitRight": ""')
    const binding = bindingFor(contents, 'splitRight')
    expect(binding?.chord).toBeNull()
    expect(binding?.negated).toBe(true)
  })

  it('reports an inexpressible chord instead of writing one cmux would reject', () => {
    const outcome = merged(POPULATED, [{ command: 'find', chord: chord(stroke('escape', 'cmd')) }])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('find')
    expect(outcome.skipped[0].reason).toContain('escape')
    // Skipping one binding must not stop the file being written at all.
    expect(outcome.contents).toBe(POPULATED)
  })

  it('reports an unknown action id rather than writing a file cmux rejects', () => {
    // `shortcuts.bindings` is `additionalProperties: false`.
    const outcome = merged(POPULATED, [managed('notARealCmuxAction', 'cmd+j')])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].reason).toContain('not a cmux action id')
    expect(outcome.contents).toBe(POPULATED)
  })

  it('creates a usable config from nothing', () => {
    const { contents } = merged(cmuxAdapter.emptyContents(), [managed('find', 'cmd+f')])
    expect(chordFor(contents, 'find')).toBe('cmd+f')
    expect(JSON.parse(contents).shortcuts.bindings.find).toBe('cmd+f')
  })

  it('refuses to write over a file it cannot read', () => {
    const outcome = cmuxAdapter.merge(MALFORMED, [managed('find', 'cmd+f')])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('refusing to write')
  })

  it('preserves CRLF line endings', () => {
    const crlf = SHORTCUTS_ONLY.replace(/\n/g, '\r\n')
    const { contents } = merged(crlf, [managed('find', 'cmd+f')])
    expect(contents.includes('\n')).toBe(true)
    expect(contents.split('\r\n').length - 1).toBe(contents.split('\n').length - 1)
  })
})

describe('emptyContents', () => {
  it('is a config cmux can read, carrying the schema reference it writes itself', () => {
    const contents = cmuxAdapter.emptyContents()
    const document = JSON.parse(contents)
    expect(document.$schema).toContain('cmux.schema.json')
    expect(document.schemaVersion).toBe(1)
    expect(document.shortcuts.bindings).toEqual({})
    expect(cmuxAdapter.parse(contents).ok).toBe(true)
  })
})

describe('defaults', () => {
  it('reports itself as partial, since the template lists only some actions', () => {
    const report = cmuxAdapter.defaults('cmux')
    expect(report.availability).toBe('partial')
    expect(report.note).toContain('0.64.22')
    expect(report.bindings.length).toBeGreaterThan(60)
  })

  it('every entry either decodes or is a recognised unbind', () => {
    // The guard against a typo in a table transcribed by hand. `sendFeedback`
    // ships unbound in the template, so "decodes" is not the whole bar.
    const report = cmuxAdapter.defaults('cmux')
    for (const binding of report.bindings) {
      expect(binding.source).toBe('default')
      if (binding.chord === null) {
        expect(binding.negated, `${binding.command} should be negated`).toBe(true)
      } else {
        expect(binding.chord.strokes.length, binding.command).toBeGreaterThan(0)
      }
    }
    expect(report.bindings.filter((b) => b.chord === null).map((b) => b.command)).toEqual([
      'sendFeedback'
    ])
  })

  it('covers the actions the catalogue maps', () => {
    const report = cmuxAdapter.defaults('cmux')
    const byCommand = new Map(report.bindings.map((b) => [b.command, b]))
    expect(formatCanonical(byCommand.get('commandPalette')!.chord!)).toBe('shift+cmd+p')
    expect(formatCanonical(byCommand.get('splitRight')!.chord!)).toBe('cmd+d')
    expect(formatCanonical(byCommand.get('closeTab')!.chord!)).toBe('cmd+w')
  })

  it('has nothing to say about another app', () => {
    const report = cmuxAdapter.defaults('ghostty')
    expect(report.availability).toBe('unavailable')
    expect(report.bindings).toEqual([])
  })
})
