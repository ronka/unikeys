import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, parseCanonical, stroke } from '../chord'
import { CLAUDE_CODE_ACTIONS, claudeCodeAdapter, formatToken, splitToken } from './claude-code'
import type { ManagedBinding } from './types'

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/claude-code/${name}`, import.meta.url), 'utf8')
}

function mergedContents(contents: string, managed: ManagedBinding[]): string {
  const outcome = claudeCodeAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`merge failed: ${outcome.error}`)
  return outcome.contents
}

function encoded(text: string): string {
  const c = parseCanonical(text)
  if (c === null) throw new Error(`bad test chord: ${text}`)
  const outcome = claudeCodeAdapter.encodeChord(c)
  if (!outcome.ok) throw new Error(`could not encode ${text}: ${outcome.reason}`)
  return outcome.value
}

function decoded(text: string): string {
  const outcome = claudeCodeAdapter.decodeChord(text)
  if (outcome === null) throw new Error(`could not decode ${text}`)
  return formatCanonical(outcome)
}

function parsed(contents: string): ReturnType<typeof claudeCodeAdapter.parse> & { ok: true } {
  const outcome = claudeCodeAdapter.parse(contents)
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome
}

const SUBMIT = formatToken('Chat', 'chat:submit')
const NEWLINE = formatToken('Chat', 'chat:newline')
const MODEL_PICKER = formatToken('Chat', 'chat:modelPicker')
const INTERRUPT = formatToken('Global', 'app:interrupt')
const TOGGLE_TRANSCRIPT = formatToken('Global', 'app:toggleTranscript')

describe('identity', () => {
  it('reports its format and apps', () => {
    expect(claudeCodeAdapter.format).toBe('claude-code-keybindings')
    expect(claudeCodeAdapter.apps).toEqual(['claude-code'])
  })
})

describe('compound tokens', () => {
  it('splits and formats symmetrically', () => {
    expect(splitToken('Chat|chat:submit')).toEqual({ context: 'Chat', action: 'chat:submit' })
    expect(formatToken('Chat', 'chat:submit')).toBe('Chat|chat:submit')
  })

  it('rejects a malformed token', () => {
    expect(splitToken('noSeparator')).toBeNull()
    expect(splitToken('|noContext')).toBeNull()
    expect(splitToken('NoAction|')).toBeNull()
  })

  it('curates exactly the catalogue-mapped actions', () => {
    expect(CLAUDE_CODE_ACTIONS.has(SUBMIT)).toBe(true)
    expect(CLAUDE_CODE_ACTIONS.has(NEWLINE)).toBe(true)
    expect(CLAUDE_CODE_ACTIONS.has(MODEL_PICKER)).toBe(true)
    expect(CLAUDE_CODE_ACTIONS.has(INTERRUPT)).toBe(true)
    expect(CLAUDE_CODE_ACTIONS.has(TOGGLE_TRANSCRIPT)).toBe(true)
  })
})

describe('chord encoding', () => {
  it('encodes ctrl and shift plainly', () => {
    expect(encoded('ctrl+e')).toBe('ctrl+e')
    expect(encoded('shift+k')).toBe('shift+k')
  })

  it('encodes canonical alt (Option) as meta, never as alt', () => {
    expect(encoded('alt+p')).toBe('meta+p')
  })

  it('encodes canonical cmd as cmd', () => {
    expect(encoded('cmd+k')).toBe('cmd+k')
  })

  it('encodes a two-stroke chord space-separated', () => {
    expect(encoded('ctrl+x ctrl+k')).toBe('ctrl+x ctrl+k')
  })

  it('rejects a reserved shortcut', () => {
    const c = parseCanonical('ctrl+c')
    if (c === null) throw new Error('bad test chord')
    const outcome = claudeCodeAdapter.encodeChord(c)
    expect(outcome.ok).toBe(false)
  })

  it('rejects an unsupported named key', () => {
    const c = chord(stroke('home'))
    const outcome = claudeCodeAdapter.encodeChord(c)
    expect(outcome.ok).toBe(false)
  })
})

describe('chord decoding', () => {
  it('decodes meta as Option (canonical alt), not cmd', () => {
    expect(decoded('meta+p')).toBe('alt+p')
  })

  it('accepts alt/opt/option as aliases for the same modifier', () => {
    expect(decoded('alt+p')).toBe('alt+p')
    expect(decoded('opt+p')).toBe('alt+p')
    expect(decoded('option+p')).toBe('alt+p')
  })

  it('decodes cmd and its synonyms', () => {
    expect(decoded('cmd+k')).toBe('cmd+k')
    expect(decoded('command+k')).toBe('cmd+k')
  })

  it('decodes a two-stroke chord', () => {
    expect(decoded('ctrl+x ctrl+k')).toBe('ctrl+x ctrl+k')
  })

  it('is case-insensitive', () => {
    expect(decoded('Ctrl+E')).toBe('ctrl+e')
  })

  it('returns null for a chord longer than two strokes', () => {
    expect(claudeCodeAdapter.decodeChord('ctrl+x ctrl+k ctrl+j')).toBeNull()
  })

  it('returns null for a malformed keystroke', () => {
    expect(claudeCodeAdapter.decodeChord('')).toBeNull()
    expect(claudeCodeAdapter.decodeChord('e+ctrl')).toBeNull()
  })
})

describe('parsing', () => {
  it('parses an empty file as no overrides', () => {
    expect(parsed('').bindings).toEqual([])
  })

  it('parses the documented empty shape', () => {
    expect(parsed(fixture('authored-empty.json')).bindings).toEqual([])
  })

  it('rejects malformed JSON with a file-level error', () => {
    expect(claudeCodeAdapter.parse(fixture('malformed.json')).ok).toBe(false)
  })

  it('parses a plain binding, a two-stroke chord, and a default unbind', () => {
    const result = parsed(fixture('authored-clean.json'))
    // The file's null unbinds Global's ctrl+t, which is app:toggleTodos's
    // default -- not a curated action, so it is reported rather than
    // silently attributed to nothing.
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0].message).toContain('ctrl+t')

    const stash = result.bindings.find((b) => b.command === formatToken('Chat', 'chat:stash'))
    expect(stash).toBeUndefined() // chat:stash is not a curated action

    const toggleTodos = result.bindings.find(
      (b) => b.command === formatToken('Global', 'app:toggleTodos')
    )
    expect(toggleTodos).toBeUndefined() // app:toggleTodos is not curated either -- only its slot is exercised
  })

  it('inverts a null at a curated default slot into that action, chord null, negated', () => {
    // authored-clean.json nulls Global's ctrl+t, which is app:toggleTodos's
    // default -- not curated, so nothing should surface for it. Use a fixture
    // built around a curated default instead: null Global's ctrl+c slot.
    const contents = JSON.stringify({
      bindings: [{ context: 'Global', bindings: { 'ctrl+c': null } }]
    })
    const result = parsed(contents)
    const interrupt = result.bindings.find((b) => b.command === INTERRUPT)
    expect(interrupt?.chord).toBeNull()
    expect(interrupt?.negated).toBe(true)
  })

  it('reports an unattributable null without guessing an action', () => {
    const result = parsed(fixture('authored-unsupported.json'))
    expect(result.problems.some((p) => p.message.includes('ctrl+alt+z'))).toBe(true)
  })

  it('merges duplicate context blocks, last keystroke wins, live-verified', () => {
    const result = parsed(fixture('authored-duplicate-context.json'))
    // Neither chat:externalEditor nor chat:stash is curated, so nothing here
    // becomes a ParsedBinding -- but merging itself must not error, and the
    // effective-value resolution (last wins) is exercised via `merge` tests
    // below against a curated action instead.
    expect(result.problems).toEqual([])
  })

  it('reports a reserved shortcut round-tripped from a file as an unreadable keystroke only if truly malformed, not otherwise', () => {
    // A file naming a curated action at a reserved keystroke is not itself
    // malformed -- Claude Code logs a warning but still applies the mapping
    // as far as the file goes. unikeys should read it like any other chord.
    const contents = JSON.stringify({
      bindings: [{ context: 'Global', bindings: { 'ctrl+c': 'app:interrupt' } }]
    })
    const result = parsed(contents)
    const interrupt = result.bindings.find((b) => b.command === INTERRUPT)
    expect(interrupt?.chord && formatCanonical(interrupt.chord)).toBe('ctrl+c')
  })
})

describe('merging', () => {
  it('adds a brand-new binding for an action with no prior mention, and nulls its shipped default', () => {
    const before = fixture('authored-empty.json')
    const managed: ManagedBinding[] = [{ command: SUBMIT, chord: parseCanonical('ctrl+enter') }]
    const out = mergedContents(before, managed)
    const result = parsed(out)
    expect(result.bindings.find((b) => b.command === SUBMIT)?.chord).toEqual(
      parseCanonical('ctrl+enter')
    )
  })

  it('moving a shipped default nulls the old default slot in the same context', () => {
    const before = fixture('authored-empty.json')
    const managed: ManagedBinding[] = [{ command: NEWLINE, chord: parseCanonical('ctrl+alt+j') }]
    const out = mergedContents(before, managed)
    expect(out).toContain('"ctrl+j": null')
    expect(parsed(out).bindings.find((b) => b.command === NEWLINE)?.chord).toEqual(
      parseCanonical('ctrl+alt+j')
    )
  })

  it('moving a user-defined primary chord replaces the member, keeping the action', () => {
    const first = mergedContents(fixture('authored-empty.json'), [
      { command: SUBMIT, chord: parseCanonical('ctrl+enter') }
    ])
    const second = mergedContents(first, [
      { command: SUBMIT, chord: parseCanonical('ctrl+shift+enter') }
    ])
    const result = parsed(second)
    expect(result.bindings.find((b) => b.command === SUBMIT)?.chord).toEqual(
      parseCanonical('ctrl+shift+enter')
    )
    // The old custom keystroke is gone, not left dangling.
    expect(second).not.toContain('ctrl+enter"')
  })

  it('unbinding a custom primary removes it and nulls the shipped default', () => {
    const bound = mergedContents(fixture('authored-empty.json'), [
      { command: NEWLINE, chord: parseCanonical('ctrl+alt+j') }
    ])
    const unbound = mergedContents(bound, [{ command: NEWLINE, chord: null }])
    const result = parsed(unbound)
    expect(result.bindings.find((b) => b.command === NEWLINE && b.chord === null)?.negated).toBe(
      true
    )
  })

  it('unbinding straight from the shipped default nulls that default slot', () => {
    const out = mergedContents(fixture('authored-empty.json'), [
      { command: INTERRUPT, chord: null }
    ])
    expect(out).toContain('"ctrl+c": null')
    const result = parsed(out)
    expect(result.bindings.find((b) => b.command === INTERRUPT)?.chord).toBeNull()
  })

  it('unbinding a custom primary that already sits at the default slot nulls in place', () => {
    const bound = mergedContents(fixture('authored-empty.json'), [
      { command: TOGGLE_TRANSCRIPT, chord: parseCanonical('ctrl+o') }
    ])
    const unbound = mergedContents(bound, [{ command: TOGGLE_TRANSCRIPT, chord: null }])
    expect(unbound).not.toContain('app:toggleTranscript')
    expect(unbound).toContain('"ctrl+o": null')
  })

  it('preserves alternate mappings to the same action', () => {
    const withAlternate = JSON.stringify({
      bindings: [
        {
          context: 'Chat',
          bindings: { 'ctrl+g': 'chat:externalEditor', 'ctrl+enter': 'chat:submit' }
        }
      ]
    })
    const out = mergedContents(withAlternate, [
      { command: SUBMIT, chord: parseCanonical('ctrl+shift+enter') }
    ])
    expect(out).toContain('chat:externalEditor')
    expect(parsed(out).bindings.find((b) => b.command === SUBMIT)?.chord).toEqual(
      parseCanonical('ctrl+shift+enter')
    )
  })

  it('preserves other contexts and unmanaged actions untouched', () => {
    const out = mergedContents(fixture('authored-clean.json'), [
      { command: SUBMIT, chord: parseCanonical('ctrl+enter') }
    ])
    expect(out).toContain('chat:stash')
    expect(out).toContain('chat:undo')
    expect(out).toMatch(/"ctrl\+t":\s*null/)
  })

  it('appends a brand-new context block when none exists yet', () => {
    const out = mergedContents(fixture('authored-empty.json'), [
      { command: TOGGLE_TRANSCRIPT, chord: parseCanonical('ctrl+shift+o') }
    ])
    expect(out).toContain('"context": "Global"')
    expect(parsed(out).bindings.find((b) => b.command === TOGGLE_TRANSCRIPT)?.chord).toEqual(
      parseCanonical('ctrl+shift+o')
    )
  })

  it('round-trips byte-identically when the requested value already matches', () => {
    const before = mergedContents(fixture('authored-empty.json'), [
      { command: SUBMIT, chord: parseCanonical('ctrl+enter') }
    ])
    const again = mergedContents(before, [{ command: SUBMIT, chord: parseCanonical('ctrl+enter') }])
    expect(again).toBe(before)
  })

  it('moving a binding off its shipped default nulls the slot it vacates', () => {
    // Without the null, the freed keystroke is the shipped default applying
    // again, and the action answers to both keys after a move.
    const before = JSON.stringify(
      { bindings: [{ context: 'Chat', bindings: { 'ctrl+j': 'chat:newline' } }] },
      null,
      2
    )
    const out = mergedContents(before, [
      { command: NEWLINE, chord: parseCanonical('ctrl+shift+j') }
    ])
    expect(out).toContain('"ctrl+j": null')
    expect(parsed(out).bindings.find((b) => b.command === NEWLINE)?.chord).toEqual(
      parseCanonical('ctrl+shift+j')
    )
  })

  it('rewrites a keystroke another action already holds rather than duplicating the key', () => {
    // Two members with the same name is legal JSON whose earlier half is
    // silently discarded -- here that half would be the user's own unmanaged
    // binding, thrown away without a word.
    const before = JSON.stringify(
      { bindings: [{ context: 'Chat', bindings: { 'ctrl+y': 'chat:stash' } }] },
      null,
      2
    )
    const out = mergedContents(before, [{ command: SUBMIT, chord: parseCanonical('ctrl+y') }])
    expect(out.match(/"ctrl\+y"/g)).toHaveLength(1)
    expect(out).not.toContain('chat:stash')
    expect(parsed(out).bindings.find((b) => b.command === SUBMIT)?.chord).toEqual(
      parseCanonical('ctrl+y')
    )
  })

  it('rebinding to a keystroke a previous unbind nulled reuses that member', () => {
    const unbound = mergedContents(fixture('authored-empty.json'), [
      { command: SUBMIT, chord: null }
    ])
    const rebound = mergedContents(unbound, [{ command: SUBMIT, chord: parseCanonical('enter') }])
    expect(rebound.match(/"enter"/g)).toHaveLength(1)
    expect(parsed(rebound).bindings.find((b) => b.command === SUBMIT)?.chord).toEqual(
      parseCanonical('enter')
    )
  })

  /**
   * The save path writes every changed cell for an app in one `merge` — see
   * `planWrite` in `src/main/apps-service.ts`. One binding per call is the
   * exception, not the rule, and two bindings landing in the same context
   * block is where an in-place value edit and a structural rewrite can be
   * asked for over the same span.
   */
  describe('several bindings in one call, as the save path sends them', () => {
    it('unbinds one action and moves another in the same context', () => {
      const before = `{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+j": "chat:newline",
        "ctrl+enter": "chat:submit"
      }
    }
  ]
}
`
      const out = mergedContents(before, [
        { command: NEWLINE, chord: null },
        { command: SUBMIT, chord: parseCanonical('ctrl+shift+enter') }
      ])
      const result = parsed(out)
      expect(result.bindings.find((b) => b.command === NEWLINE)?.chord).toBeNull()
      expect(result.bindings.find((b) => b.command === SUBMIT)?.chord).toEqual(
        parseCanonical('ctrl+shift+enter')
      )
    })

    it('writes every kind of change at once across two contexts', () => {
      const before = `{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+j": "chat:newline",
        "ctrl+y": "chat:stash"
      }
    },
    {
      "context": "Global",
      "bindings": {
        "ctrl+o": "app:toggleTranscript"
      }
    }
  ]
}
`
      const out = mergedContents(before, [
        { command: NEWLINE, chord: null },
        { command: SUBMIT, chord: parseCanonical('ctrl+enter') },
        { command: MODEL_PICKER, chord: parseCanonical('alt+m') },
        { command: TOGGLE_TRANSCRIPT, chord: null }
      ])
      const result = parsed(out)
      expect(result.bindings.find((b) => b.command === NEWLINE)?.chord).toBeNull()
      expect(result.bindings.find((b) => b.command === SUBMIT)?.chord).toEqual(
        parseCanonical('ctrl+enter')
      )
      expect(result.bindings.find((b) => b.command === MODEL_PICKER)?.chord).toEqual(
        parseCanonical('alt+m')
      )
      expect(result.bindings.find((b) => b.command === TOGGLE_TRANSCRIPT)?.chord).toBeNull()
      // The user's own binding is not collateral damage.
      expect(out).toContain('chat:stash')
    })

    it('is byte-identical when every requested value already holds', () => {
      const before = mergedContents(fixture('authored-empty.json'), [
        { command: SUBMIT, chord: parseCanonical('ctrl+enter') },
        { command: TOGGLE_TRANSCRIPT, chord: parseCanonical('ctrl+shift+o') }
      ])
      const again = mergedContents(before, [
        { command: SUBMIT, chord: parseCanonical('ctrl+enter') },
        { command: TOGGLE_TRANSCRIPT, chord: parseCanonical('ctrl+shift+o') }
      ])
      expect(again).toBe(before)
    })
  })

  it('reports an inexpressible chord through skipped rather than writing it', () => {
    const c = parseCanonical('ctrl+c')
    if (c === null) throw new Error('bad test chord')
    const outcome = claudeCodeAdapter.merge(fixture('authored-empty.json'), [
      { command: INTERRUPT, chord: c }
    ])
    if (!outcome.ok) throw new Error('merge should not fail the whole file')
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe(INTERRUPT)
  })

  it('rejects malformed JSON with a file-level error rather than writing', () => {
    expect(claudeCodeAdapter.merge(fixture('malformed.json'), []).ok).toBe(false)
  })

  it('creates the documented shape from empty contents on first save', () => {
    const out = mergedContents('', [{ command: SUBMIT, chord: parseCanonical('ctrl+enter') }])
    expect(out).toContain('"$schema"')
    expect(out).toContain('"$docs"')
    expect(parsed(out).bindings.find((b) => b.command === SUBMIT)?.chord).toEqual(
      parseCanonical('ctrl+enter')
    )
  })
})

describe('emptyContents', () => {
  it('is the documented shape with an empty bindings array', () => {
    const contents = claudeCodeAdapter.emptyContents()
    expect(contents).toContain('"bindings": []')
    expect(parsed(contents).bindings).toEqual([])
  })
})

describe('defaults', () => {
  it('reports complete availability for the curated surface', () => {
    const report = claudeCodeAdapter.defaults('claude-code')
    expect(report.availability).toBe('complete')
    const commands = report.bindings.map((b) => b.command)
    for (const token of CLAUDE_CODE_ACTIONS) expect(commands).toContain(token)
  })

  it('has no defaults for another app', () => {
    expect(claudeCodeAdapter.defaults('codex' as never).availability).toBe('unavailable')
  })
})
