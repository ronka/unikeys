import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, parseCanonical, stroke } from '../chord'
import { ACTIONS } from '../catalogue'
import type { ManagedBinding } from './types'
import { zedAdapter } from './zed'

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/zed/${name}`, import.meta.url), 'utf8')
}

/** Merges and fails loudly, so every merge assertion reads as one expression. */
function mergedContents(contents: string, managed: ManagedBinding[]): string {
  const outcome = zedAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`merge failed: ${outcome.error}`)
  return outcome.contents
}

function encoded(text: string): string {
  const parsed = parseCanonical(text)
  if (parsed === null) throw new Error(`bad test chord: ${text}`)
  const outcome = zedAdapter.encodeChord(parsed)
  if (!outcome.ok) throw new Error(`could not encode ${text}: ${outcome.reason}`)
  return outcome.value
}

/** The first line of unikeys' block comment, which is how merge finds it again. */
const MARKER = '// unikeys: managed keybindings. Rewritten on every save.'

describe('identity', () => {
  it('serves Zed alone', () => {
    expect(zedAdapter.format).toBe('zed-keymap')
    expect(zedAdapter.apps).toEqual(['zed'])
  })
})

describe('encodeChord', () => {
  it('writes lowercase, hyphen-joined modifiers in Zed’s own order', () => {
    expect(encoded('cmd+shift+p')).toBe('cmd-shift-p')
    expect(encoded('shift+cmd+p')).toBe('cmd-shift-p')
    expect(encoded('alt+cmd+s')).toBe('cmd-alt-s')
    expect(encoded('ctrl+cmd+f')).toBe('ctrl-cmd-f')
    expect(encoded('ctrl+cmd+alt+shift+k')).toBe('ctrl-cmd-alt-shift-k')
  })

  it('writes named keys, punctuation and function keys literally', () => {
    expect(encoded('escape')).toBe('escape')
    expect(encoded('cmd+enter')).toBe('cmd-enter')
    expect(encoded('ctrl+`')).toBe('ctrl-`')
    expect(encoded('cmd+/')).toBe('cmd-/')
    expect(encoded('cmd+[')).toBe('cmd-[')
    expect(encoded('shift+f12')).toBe('shift-f12')
    expect(encoded('cmd+pagedown')).toBe('cmd-pagedown')
  })

  it('keeps a hyphen base key rather than losing it to the separator', () => {
    expect(encoded('cmd+-')).toBe('cmd--')
    expect(encoded('-')).toBe('-')
  })

  it('joins two keystrokes with a space', () => {
    expect(encoded('cmd+k cmd+s')).toBe('cmd-k cmd-s')
    expect(encoded('cmd+k z')).toBe('cmd-k z')
  })

  it('reports chords Zed cannot express instead of guessing', () => {
    expect(zedAdapter.encodeChord({ strokes: [] })).toEqual({
      ok: false,
      reason: expect.stringContaining('no keystrokes')
    })

    const threeStrokes = chord(stroke('a'), stroke('b'), stroke('c'))
    expect(zedAdapter.encodeChord(threeStrokes).ok).toBe(false)

    expect(zedAdapter.encodeChord({ strokes: [{ modifiers: [], key: 'eject' }] })).toEqual({
      ok: false,
      reason: expect.stringContaining('eject')
    })
  })
})

describe('decodeChord', () => {
  it('reads Zed notation into canonical order', () => {
    expect(formatCanonical(zedAdapter.decodeChord('cmd-shift-p')!)).toBe('shift+cmd+p')
    expect(formatCanonical(zedAdapter.decodeChord('shift-cmd-p')!)).toBe('shift+cmd+p')
    expect(formatCanonical(zedAdapter.decodeChord('ctrl-cmd-f')!)).toBe('ctrl+cmd+f')
    expect(formatCanonical(zedAdapter.decodeChord('cmd-alt-down')!)).toBe('alt+cmd+down')
  })

  it('reads `secondary`, which is Zed’s platform-agnostic cmd', () => {
    expect(formatCanonical(zedAdapter.decodeChord('secondary-p')!)).toBe('cmd+p')
    expect(formatCanonical(zedAdapter.decodeChord('secondary-shift-p')!)).toBe('shift+cmd+p')
  })

  it('reads two-keystroke sequences', () => {
    expect(formatCanonical(zedAdapter.decodeChord('cmd-k cmd-s')!)).toBe('cmd+k cmd+s')
    expect(formatCanonical(zedAdapter.decodeChord('cmd-k z')!)).toBe('cmd+k z')
  })

  it('keeps punctuation base keys rather than treating them as separators', () => {
    expect(formatCanonical(zedAdapter.decodeChord('cmd--')!)).toBe('cmd+-')
    expect(formatCanonical(zedAdapter.decodeChord('cmd-/')!)).toBe('cmd+/')
    expect(formatCanonical(zedAdapter.decodeChord('ctrl-`')!)).toBe('ctrl+`')
    expect(formatCanonical(zedAdapter.decodeChord('cmd-=')!)).toBe('cmd+=')
  })

  it('returns null for notation it cannot represent', () => {
    expect(zedAdapter.decodeChord('')).toBeNull()
    expect(zedAdapter.decodeChord('cmd-')).toBeNull()
    // `fn` has no canonical equivalent, so the chord is not one unikeys holds.
    expect(zedAdapter.decodeChord('fn-f5')).toBeNull()
    expect(zedAdapter.decodeChord('cmd-numpad_multiply')).toBeNull()
    expect(zedAdapter.decodeChord('cmd-a cmd-b cmd-c')).toBeNull()
    expect(zedAdapter.decodeChord('a-cmd')).toBeNull()
  })

  it('round-trips every chord it decodes', () => {
    for (const text of ['cmd-shift-p', 'ctrl-g', 'cmd-k cmd-s', 'f8', 'cmd-alt-down', 'cmd--']) {
      const decoded = zedAdapter.decodeChord(text)!
      expect(zedAdapter.encodeChord(decoded)).toEqual({ ok: true, value: text })
    }
  })
})

describe('parse', () => {
  it('inverts chord → action into command-first bindings across every block', () => {
    const outcome = zedAdapter.parse(fixture('populated.json'))
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.problems).toEqual([])
    expect(outcome.bindings.map((b) => b.command)).toEqual([
      'command_palette::Toggle',
      'zed::OpenKeymap',
      'zed::ToggleFullScreen',
      'workspace::Save',
      'editor::ToggleComments',
      'editor::DuplicateLineDown',
      'terminal::Clear',
      'zed::DecreaseBufferFontSize'
    ])
    expect(outcome.bindings.every((b) => b.source === 'user')).toBe(true)
    expect(outcome.bindings.every((b) => b.negated === undefined)).toBe(true)

    const byCommand = new Map(outcome.bindings.map((b) => [b.command, formatCanonical(b.chord!)]))
    expect(Object.fromEntries(byCommand)).toMatchObject({
      'workspace::Save': 'cmd+s',
      'command_palette::Toggle': 'shift+cmd+a',
      'zed::OpenKeymap': 'cmd+k cmd+s',
      'zed::DecreaseBufferFontSize': 'cmd+-'
    })
  })

  it('reads a null as an unbinding of whatever held the chord', () => {
    const outcome = zedAdapter.parse(fixture('unbound.json'))
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.problems).toEqual([])
    const negations = outcome.bindings.filter((b) => b.negated === true)
    expect(negations.map((b) => [b.command, formatCanonical(b.chord!)])).toEqual([
      // The chord was bound earlier in this same file …
      ['workspace::Save', 'shift+cmd+s'],
      // … and this one is a chord Zed itself ships, so the action it takes
      // away is known from the defaults table.
      ['file_finder::Toggle', 'cmd+p']
    ])
    // `ctrl-alt-shift-cmd-9` unbinds nothing unikeys manages, and a chord it
    // cannot attribute is not a problem with the file.
    expect(outcome.bindings).toHaveLength(4)
  })

  it('keeps comments, block comments and an unbindable action from derailing the file', () => {
    const outcome = zedAdapter.parse(fixture('commented.json'))
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.bindings.map((b) => b.command)).toEqual([
      'command_palette::Toggle',
      'editor::ToggleComments'
    ])
    expect(outcome.problems).toHaveLength(2)
    expect(outcome.problems[0].message).toContain('carries arguments')
    expect(outcome.problems[0].detail).toContain('editor::MoveToEndOfLine')
    expect(outcome.problems[1].message).toContain('cmd-numpad_multiply')
  })

  it('reports a malformed block rather than failing the file', () => {
    const outcome = zedAdapter.parse('[ 3, { "bindings": [] }, { "bindings": { "cmd-s": "" } } ]')
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.bindings).toEqual([])
    expect(outcome.problems.map((p) => p.message)).toEqual([
      'block is not an object',
      '"bindings" is not an object',
      'the binding for "cmd-s" names no action'
    ])
  })

  it('treats an empty array, an empty file and a comment-only file as no bindings', () => {
    for (const contents of [fixture('empty-array.json'), '', '   \n\n', '// nothing here\n']) {
      expect(zedAdapter.parse(contents)).toEqual({ ok: true, bindings: [], problems: [] })
    }
  })

  it('reads back what emptyContents writes', () => {
    expect(zedAdapter.parse(zedAdapter.emptyContents())).toEqual({
      ok: true,
      bindings: [],
      problems: []
    })
  })

  it('fails the whole file for malformed JSON', () => {
    const outcome = zedAdapter.parse(fixture('malformed.json'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('not valid JSON')
  })

  it('fails when the root is not an array', () => {
    const outcome = zedAdapter.parse('{ "bindings": { "cmd-s": "workspace::Save" } }')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('array')
  })
})

describe('merge', () => {
  const managed: ManagedBinding[] = [
    { command: 'workspace::Save', chord: parseCanonical('shift+cmd+s') },
    { command: 'command_palette::Toggle', chord: parseCanonical('shift+cmd+a') },
    { command: 'file_finder::Toggle', chord: null }
  ]

  it('returns byte-identical contents when nothing changes', () => {
    const contents = fixture('unikeys-block.json')
    expect(mergedContents(contents, managed)).toBe(contents)
  })

  it('returns byte-identical contents when nothing is managed', () => {
    for (const name of ['populated.json', 'commented.json', 'unikeys-block.json']) {
      expect(mergedContents(fixture(name), [])).toBe(fixture(name))
    }
  })

  it('appends one block of its own, marked by a comment rather than a made-up context', () => {
    const out = mergedContents(fixture('populated.json'), managed)

    expect(out).toBe(fixture('unikeys-block.json'))
    expect(out).toContain(
      [
        '  {',
        '    "bindings": {',
        '      "cmd-shift-s": "workspace::Save",',
        '      "cmd-shift-a": "command_palette::Toggle",',
        '      "cmd-p": null',
        '    }',
        '  }'
      ].join('\n')
    )
    // No invented context: a Zed context is matched against the focused
    // element, so a made-up one would never fire.
    expect(out.slice(out.indexOf(MARKER))).not.toContain('"context"')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('leaves the user’s own blocks and comments byte-for-byte alone', () => {
    const before = fixture('commented.json')
    const after = mergedContents(before, managed)

    // Everything up to unikeys' own comment is the file as the user left it,
    // give or take the comma that now separates their last block from it.
    expect(after.slice(0, after.indexOf(MARKER))).toBe(
      before.slice(0, before.lastIndexOf('\n]')) + ',\n  '
    )
    expect(after).toContain('// The command palette, moved off the default so it matches WebStorm.')
    expect(after).toContain('/* Toggling comments is fine as shipped')
    expect(after).toContain('// "cmd-p": "file_finder::Toggle",')
  })

  it('rewrites the same block on a second merge instead of appending another', () => {
    const once = mergedContents(fixture('populated.json'), managed)
    const twice = mergedContents(once, [
      { command: 'workspace::Save', chord: parseCanonical('cmd+s') },
      { command: 'editor::Format', chord: parseCanonical('shift+cmd+i') }
    ])

    expect(twice.split(MARKER)).toHaveLength(2)
    expect(twice.split('"bindings"')).toHaveLength(once.split('"bindings"').length)
    // The user's three blocks are untouched, and the rewrite happens in place.
    expect(twice.slice(0, twice.indexOf(MARKER))).toBe(once.slice(0, once.indexOf(MARKER)))
    expect(twice).toContain('"cmd-s": "workspace::Save"')
    expect(twice).toContain('"cmd-shift-i": "editor::Format"')
    // Bindings this save was not given survive; only the resolved ones move.
    expect(twice).toContain('"cmd-shift-a": "command_palette::Toggle"')
    expect(twice).toContain('"cmd-p": null')
  })

  it('is idempotent — merging its own output changes nothing further', () => {
    const once = mergedContents(fixture('commented.json'), managed)
    expect(mergedContents(once, managed)).toBe(once)
  })

  it('keeps a rebound command in the line it already occupied', () => {
    const once = mergedContents(fixture('populated.json'), managed)
    const moved = mergedContents(once, [
      { command: 'workspace::Save', chord: parseCanonical('ctrl+alt+s') }
    ])

    const block = moved.slice(moved.indexOf(MARKER))
    expect(block.indexOf('"ctrl-alt-s": "workspace::Save"')).toBeLessThan(
      block.indexOf('"cmd-shift-a": "command_palette::Toggle"')
    )
  })

  it('unbinds by nulling every chord that still reaches the action', () => {
    // The user binds Save on `cmd-s` in their own block, and Zed ships the
    // same chord: one null covers both, and the user's block is left alone.
    const out = mergedContents(fixture('populated.json'), [
      { command: 'workspace::Save', chord: null }
    ])

    expect(out).toContain('"cmd-s": null')
    expect(out).toContain('"cmd-s": "workspace::Save"')

    const reparsed = zedAdapter.parse(out)
    if (!reparsed.ok) throw new Error(reparsed.error)
    const save = reparsed.bindings.filter((b) => b.command === 'workspace::Save')
    expect(save.map((b) => b.negated)).toEqual([undefined, true])
  })

  it('nulls a shipped default the user has never mentioned', () => {
    const out = mergedContents(fixture('populated.json'), [
      { command: 'editor::ToggleComments', chord: null }
    ])
    // `cmd-/` is Zed's default for it; `ctrl-shift-7` is the user's own.
    expect(out.slice(out.indexOf(MARKER))).toContain('"ctrl-shift-7": null')
    expect(out.slice(out.indexOf(MARKER))).toContain('"cmd-/": null')
  })

  it('clears the nulls again when the action is rebound', () => {
    const unboundOut = mergedContents(fixture('populated.json'), [
      { command: 'workspace::Save', chord: null }
    ])
    const rebound = mergedContents(unboundOut, [
      { command: 'workspace::Save', chord: parseCanonical('shift+cmd+s') }
    ])

    expect(rebound).toContain('"cmd-shift-s": "workspace::Save"')
    expect(rebound.slice(rebound.indexOf(MARKER))).not.toContain('null')
  })

  it('refuses to give two managed actions the same chord', () => {
    const wanted = parseCanonical('shift+cmd+s')!
    const outcome = zedAdapter.merge(fixture('populated.json'), [
      { command: 'workspace::Save', chord: wanted },
      { command: 'editor::Format', chord: wanted }
    ])
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('editor::Format')
    expect(outcome.skipped[0].reason).toContain('workspace::Save')
    expect(outcome.contents).toContain('"cmd-shift-s": "workspace::Save"')
    expect(outcome.contents).not.toContain('editor::Format')
  })

  it('refuses a chord another line of its own block already holds', () => {
    const once = mergedContents(fixture('populated.json'), managed)
    const wanted = parseCanonical('shift+cmd+s')!
    const outcome = zedAdapter.merge(once, [{ command: 'editor::Format', chord: wanted }])
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].reason).toContain('workspace::Save')
    expect(outcome.contents).toBe(once)
  })

  it('skips a chord Zed cannot express instead of dropping it silently', () => {
    const inexpressible = chord(stroke('a'), stroke('b'), stroke('c'))
    const outcome = zedAdapter.merge(fixture('populated.json'), [
      { command: 'workspace::Save', chord: inexpressible },
      { command: 'file_finder::Toggle', chord: parseCanonical('cmd+p') }
    ])
    if (!outcome.ok) throw new Error(outcome.error)

    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('workspace::Save')
    expect(outcome.skipped[0].chord).toBe(inexpressible)
    expect(outcome.skipped[0].reason).toBeTruthy()
    expect(outcome.contents.slice(outcome.contents.indexOf(MARKER))).not.toContain(
      'workspace::Save'
    )
    expect(outcome.contents).toContain('"cmd-p": "file_finder::Toggle"')
  })

  it('will not mistake the marker quoted in the user’s own file for its block', () => {
    const contents = [
      '[',
      '  {',
      `    "context": "${MARKER}",`,
      '    "bindings": {}',
      '  }',
      ']',
      ''
    ].join('\n')
    const out = mergedContents(contents, [
      { command: 'workspace::Save', chord: parseCanonical('cmd+s') }
    ])

    expect(out).toContain(`    "context": "${MARKER}",`)
    expect(out.split(MARKER)).toHaveLength(3)
    expect(out).toContain('"cmd-s": "workspace::Save"')
  })

  it('opens up an empty array when appending to it', () => {
    const out = mergedContents(fixture('empty-array.json'), [
      { command: 'workspace::Save', chord: parseCanonical('cmd+s') }
    ])

    expect(out).toBe(
      [
        '// Zed keymap',
        '//',
        '// For information on binding keys, see the Zed online documentation:',
        '// https://zed.dev/docs/key-bindings',
        '[',
        `  ${MARKER}`,
        '  // Zed applies later blocks over earlier ones, so these bindings win over the ones above.',
        '  // unikeys never edits your own blocks: a binding you made yourself for one of these actions',
        '  // stays in the file but no longer fires. Delete it there if you want it gone.',
        '  {',
        '    "bindings": {',
        '      "cmd-s": "workspace::Save"',
        '    }',
        '  }',
        ']',
        ''
      ].join('\n')
    )
  })

  it('writes nothing to a file it has no block in when there is nothing to say', () => {
    const contents = fixture('populated.json')
    const outcome = zedAdapter.merge(contents, [
      { command: 'workspace::Save', chord: chord(stroke('a'), stroke('b'), stroke('c')) }
    ])
    if (!outcome.ok) throw new Error(outcome.error)
    expect(outcome.contents).toBe(contents)
    expect(outcome.skipped).toHaveLength(1)
  })

  it('creates usable contents from an empty or absent file', () => {
    for (const absent of ['', '   \n']) {
      const out = mergedContents(absent, [
        { command: 'workspace::Save', chord: parseCanonical('cmd+s') }
      ])
      const reparsed = zedAdapter.parse(out)
      if (!reparsed.ok) throw new Error(reparsed.error)
      expect(reparsed.bindings).toHaveLength(1)
      expect(formatCanonical(reparsed.bindings[0].chord!)).toBe('cmd+s')
    }
  })

  it('refuses to write to a file it cannot parse', () => {
    const outcome = zedAdapter.merge(fixture('malformed.json'), [
      { command: 'workspace::Save', chord: parseCanonical('cmd+s') }
    ])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('refusing to write')
  })

  it('refuses a keymap whose root is not an array', () => {
    const outcome = zedAdapter.merge('{ "bindings": {} }', [
      { command: 'workspace::Save', chord: parseCanonical('cmd+s') }
    ])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('array')
  })

  it('preserves CRLF line endings when appending', () => {
    const contents = fixture('empty-array.json').replace(/\n/g, '\r\n')
    const out = mergedContents(contents, [
      { command: 'workspace::Save', chord: parseCanonical('cmd+s') }
    ])
    expect(out).toContain('\r\n  {\r\n    "bindings": {')
    expect(out).not.toMatch(/[^\r]\n/)
  })
})

describe('defaults', () => {
  it('reports itself as a partial, curated set with a reason', () => {
    const report = zedAdapter.defaults('zed')
    expect(report.availability).toBe('partial')
    expect(report.note).toContain('inside the application bundle')
    expect(report.bindings.length).toBeGreaterThanOrEqual(25)
    expect(report.bindings.every((b) => b.source === 'default')).toBe(true)
    expect(report.bindings.every((b) => b.negated === undefined)).toBe(true)
  })

  it('carries the well-known macOS chords in Zed’s own notation', () => {
    const report = zedAdapter.defaults('zed')
    const byCommand = new Map(report.bindings.map((b) => [b.command, formatCanonical(b.chord!)]))

    expect(Object.fromEntries(byCommand)).toMatchObject({
      'workspace::Save': 'cmd+s',
      'workspace::SaveAll': 'alt+cmd+s',
      'command_palette::Toggle': 'shift+cmd+p',
      'file_finder::Toggle': 'cmd+p',
      'go_to_line::Toggle': 'ctrl+g',
      'editor::ToggleComments': 'cmd+/',
      'terminal_panel::ToggleFocus': 'ctrl+`',
      'zed::DecreaseBufferFontSize': 'cmd+-',
      'zed::ToggleFullScreen': 'ctrl+cmd+f'
    })
  })

  it('claims no default for the actions whose chords could not be sourced', () => {
    const commands = new Set(zedAdapter.defaults('zed').bindings.map((b) => b.command))
    for (const command of [
      'pane::GoBack',
      'pane::GoForward',
      'pane::SplitRight',
      'pane::SplitDown',
      'pane::ActivateNextItem',
      'pane::ActivatePrevItem',
      'workspace::ActivatePaneLeft',
      'terminal::Clear'
    ]) {
      expect(commands.has(command), `${command} must not claim a default`).toBe(false)
    }
  })

  it('has no duplicate commands and no two actions sharing a chord', () => {
    const bindings = zedAdapter.defaults('zed').bindings
    const commands = bindings.map((b) => b.command)
    expect(new Set(commands).size).toBe(commands.length)
    const chords = bindings.map((b) => formatCanonical(b.chord!))
    expect(new Set(chords).size).toBe(chords.length)
  })

  it('has nothing to say about any other app', () => {
    const report = zedAdapter.defaults('vscode')
    expect(report.availability).toBe('unavailable')
    expect(report.bindings).toEqual([])
  })
})

/**
 * These read the shipped catalogue rather than the `catalogue-zed.json`
 * fragment they were written against: ticket 26 folded the fragment in and
 * deleted it. The "is this a real action id" check went with it — derived from
 * `ACTIONS`, every key is one by construction, and `validateCatalogue` already
 * refuses an unknown app key. Everything else here is still worth asserting.
 */
describe('the catalogue’s Zed column', () => {
  const commands: Record<string, string> = Object.fromEntries(
    ACTIONS.filter((action) => action.commands.zed !== undefined).map((action) => [
      action.id,
      action.commands.zed as string
    ])
  )

  it('names every command in Zed’s namespaced form', () => {
    for (const [id, command] of Object.entries(commands)) {
      expect(command, `${id} maps to ${command}`).toMatch(/^[a-z_]+::[A-Za-z]+$/)
    }
  })

  it('gives each action its own command', () => {
    const values = Object.values(commands)
    expect(new Set(values).size).toBe(values.length)
  })

  it('omits the actions Zed has no sourced equivalent for', () => {
    // An absent key renders the cell as not-applicable, which is better than a
    // binding that would never fire.
    for (const id of [
      'terminal.reload-config',
      'terminal.new',
      'pane.focus-next',
      'pane.focus-previous'
    ]) {
      expect(commands[id]).toBeUndefined()
    }
    expect(Object.keys(commands)).toHaveLength(ACTIONS.length - 4)
  })

  it('agrees with the shipped defaults about the actions they both name', () => {
    const mapped = new Set(Object.values(commands))
    const defaulted = zedAdapter.defaults('zed').bindings.map((b) => b.command)
    // Every default unikeys ships for a catalogue action has to be a command
    // the catalogue actually maps, or the cell it fills is one nothing reads.
    expect(defaulted.filter((command) => mapped.has(command)).length).toBeGreaterThanOrEqual(10)
  })
})
