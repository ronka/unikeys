import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { chord, formatCanonical, parseCanonical, stroke } from '../chord'
import type { Chord } from '../chord'
import { adapterFor } from './index'
import { jetbrainsAdapter, parseKeymap, resolveInheritance } from './jetbrains'
import type { Keymap } from './jetbrains'

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/jetbrains/${name}`, import.meta.url)),
    'utf8'
  )
}

const userKeymap = fixture('user-keymap.xml')
const parentKeymap = fixture('parent-macos.xml')
const grandparentKeymap = fixture('grandparent-default.xml')
const malformed = fixture('malformed.xml')

function keymap(contents: string): Keymap {
  const outcome = parseKeymap(contents)
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome
}

function bindingFor(contents: string, command: string): string | undefined {
  const outcome = jetbrainsAdapter.parse(contents)
  if (!outcome.ok) throw new Error(outcome.error)
  const found = outcome.bindings.find((b) => b.command === command)
  // A removed action parses as a chordless negated binding, which reads the
  // same as absent for the purposes of "what chord does this file state".
  return found?.chord ? formatCanonical(found.chord) : undefined
}

function canonical(text: string): Chord {
  const parsed = parseCanonical(text)
  if (!parsed) throw new Error(`bad test chord: ${text}`)
  return parsed
}

function merged(
  contents: string,
  managed: Array<{ command: string; chord: Chord | null }>
): string {
  const outcome = jetbrainsAdapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome.contents
}

describe('adapter identity', () => {
  it('declares its format and every IDE it serves', () => {
    expect(jetbrainsAdapter.format).toBe('jetbrains-keymap')
    expect(jetbrainsAdapter.apps).toEqual(['webstorm', 'intellij', 'pycharm'])
  })

  it('is the adapter the registry hands back for all three IDEs', () => {
    for (const app of ['webstorm', 'intellij', 'pycharm'] as const) {
      expect(adapterFor(app)).toBe(jetbrainsAdapter)
    }
  })
})

describe('chord translation', () => {
  it('encodes modifiers in the order the IDEs write them', () => {
    expect(jetbrainsAdapter.encodeChord(canonical('cmd+shift+p'))).toEqual({
      ok: true,
      value: 'shift meta P'
    })
    expect(jetbrainsAdapter.encodeChord(canonical('ctrl+alt+left'))).toEqual({
      ok: true,
      value: 'ctrl alt LEFT'
    })
  })

  it('encodes named and punctuation keys with their Java names', () => {
    const cases: Array<[string, string]> = [
      ['cmd+backspace', 'meta BACK_SPACE'],
      ['cmd+/', 'meta SLASH'],
      ['cmd+shift+[', 'shift meta OPEN_BRACKET'],
      ['alt+enter', 'alt ENTER'],
      ['cmd+pageup', 'meta PAGE_UP'],
      ['shift+f5', 'shift F5'],
      ['cmd+`', 'meta BACK_QUOTE'],
      ['ctrl+space', 'ctrl SPACE']
    ]
    for (const [input, expected] of cases) {
      expect(jetbrainsAdapter.encodeChord(canonical(input))).toEqual({ ok: true, value: expected })
    }
  })

  it('decodes case-insensitively and in any modifier order', () => {
    for (const text of ['shift meta P', 'META SHIFT p', 'meta shift P']) {
      expect(formatCanonical(jetbrainsAdapter.decodeChord(text)!)).toBe('shift+cmd+p')
    }
    expect(formatCanonical(jetbrainsAdapter.decodeChord('alt ctrl LEFT')!)).toBe('ctrl+alt+left')
    expect(formatCanonical(jetbrainsAdapter.decodeChord('back_slash')!)).toBe('\\')
  })

  it('round-trips every canonical key it claims to support', () => {
    for (const text of [
      'a',
      'z',
      '9',
      'f12',
      'escape',
      'delete',
      'insert',
      'home',
      ';',
      "'",
      '='
    ]) {
      const encoded = jetbrainsAdapter.encodeChord(canonical(`cmd+${text}`))
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) return
      expect(formatCanonical(jetbrainsAdapter.decodeChord(encoded.value)!)).toBe(`cmd+${text}`)
    }
  })

  it('handles two-keystroke sequences in both directions', () => {
    const two = chord(stroke('t', 'ctrl'), stroke('r', 'ctrl'))
    const encoded = jetbrainsAdapter.encodeChord(two)
    expect(encoded).toEqual({ ok: true, value: 'ctrl T, ctrl R' })
    if (!encoded.ok) return
    expect(formatCanonical(jetbrainsAdapter.decodeChord(encoded.value)!)).toBe('ctrl+t ctrl+r')
  })

  it('refuses chords a keymap cannot express, without naming one IDE', () => {
    expect(jetbrainsAdapter.encodeChord({ strokes: [] }).ok).toBe(false)
    const three = { strokes: [stroke('a', 'cmd'), stroke('b', 'cmd'), stroke('c', 'cmd')] }
    const tooMany = jetbrainsAdapter.encodeChord(three)
    expect(tooMany.ok).toBe(false)
    const unknownKey = jetbrainsAdapter.encodeChord({
      strokes: [{ modifiers: ['cmd'], key: 'eject' }]
    })
    expect(unknownKey.ok).toBe(false)
    // The reason reaches the user beside an IntelliJ or PyCharm cell just as
    // often as a WebStorm one, so it must not claim to be about WebStorm.
    for (const outcome of [tooMany, unknownKey]) {
      if (outcome.ok) continue
      expect(outcome.reason).not.toMatch(/WebStorm/)
    }
  })

  it('returns null rather than guessing at unreadable notation', () => {
    for (const text of ['', '   ', 'meta', 'meta A B', 'A meta', 'meta NOSUCHKEY', 'a, b, c']) {
      expect(jetbrainsAdapter.decodeChord(text)).toBeNull()
    }
  })
})

describe('parse', () => {
  it('reads single and two-keystroke shortcuts', () => {
    expect(bindingFor(userKeymap, 'SaveAll')).toBe('cmd+s')
    expect(bindingFor(userKeymap, 'EditorSelectWord')).toBe('alt+up')
    expect(bindingFor(userKeymap, 'Refactorings.QuickListPopupAction')).toBe('ctrl+t ctrl+r')
    expect(bindingFor(userKeymap, 'ShowSettings')).toBe('cmd+,')
  })

  it('shows the first shortcut when an action has several', () => {
    expect(bindingFor(userKeymap, 'GotoImplementation')).toBe('alt+cmd+b')
  })

  it('emits no chord for an action with its shortcut removed', () => {
    expect(bindingFor(userKeymap, 'GotoDeclaration')).toBeUndefined()
    // Mouse shortcuts are not keyboard bindings, so this counts as removed too.
    expect(bindingFor(userKeymap, 'ActivateTerminalToolWindow')).toBeUndefined()
  })

  it('surfaces a removal as a chordless negated binding, not as an absence', () => {
    const outcome = jetbrainsAdapter.parse(userKeymap)
    if (!outcome.ok) throw new Error(outcome.error)
    const removed = outcome.bindings.find((b) => b.command === 'GotoDeclaration')
    // A caller holding only the Adapter interface has no inheritance chain, so
    // this is the only way it can tell a deliberate unbind from silence.
    expect(removed).toMatchObject({ chord: null, negated: true, source: 'user' })
  })

  it('records removed actions separately from bindings', () => {
    const parsed = keymap(userKeymap)
    expect(parsed.removed).toEqual(['ActivateTerminalToolWindow', 'GotoDeclaration'])
    expect(parsed.bindings.map((b) => b.command)).not.toContain('GotoDeclaration')
  })

  it('reads the keymap name and parent', () => {
    const parsed = keymap(userKeymap)
    expect(parsed.name).toBe('macOS copy')
    expect(parsed.parent).toBe('Mac OS X 10.5+')
    expect(keymap(grandparentKeymap).parent).toBeNull()
  })

  it('marks a file’s own bindings as the user’s', () => {
    const parsed = keymap(userKeymap)
    expect(parsed.bindings.every((b) => b.source === 'user')).toBe(true)
  })

  it('keeps good bindings when one entry is unreadable', () => {
    const contents = `<keymap version="1" name="x" parent="p">
  <action id="Good"><keyboard-shortcut first-keystroke="meta s" /></action>
  <action id="Bad"><keyboard-shortcut first-keystroke="meta NOPE" /></action>
  <action id="Alsobad"><keyboard-shortcut /></action>
  <action><keyboard-shortcut first-keystroke="meta q" /></action>
</keymap>`
    const outcome = jetbrainsAdapter.parse(contents)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.bindings.map((b) => b.command)).toEqual(['Good'])
    expect(outcome.problems).toHaveLength(3)
    expect(outcome.problems[0].detail).toBe('meta NOPE')
  })

  it('fails the whole file on malformed XML', () => {
    const outcome = jetbrainsAdapter.parse(malformed)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/action/)
  })

  it('rejects a document that is not a keymap', () => {
    expect(jetbrainsAdapter.parse('<component name="x" />')).toEqual({
      ok: false,
      error: 'Expected a <keymap> root element but found <component>'
    })
    expect(jetbrainsAdapter.parse('').ok).toBe(false)
    expect(jetbrainsAdapter.parse('<keymap><!-- unterminated </keymap>').ok).toBe(false)
    expect(jetbrainsAdapter.parse('<keymap name=unquoted></keymap>').ok).toBe(false)
  })
})

describe('inheritance resolution', () => {
  const child = (): Keymap => keymap(userKeymap)
  const ancestors = (): Keymap[] => [keymap(parentKeymap), keymap(grandparentKeymap)]

  function resolvedMap(): Map<string, { chord: string | null; source: string }> {
    const entries = resolveInheritance(child(), ancestors())
    return new Map(
      entries.map((b) => [
        b.command,
        { chord: b.chord ? formatCanonical(b.chord) : null, source: b.source }
      ])
    )
  }

  it('surfaces a binding only the parent states, as a default', () => {
    expect(resolvedMap().get('ReformatCode')).toEqual({ chord: 'alt+cmd+l', source: 'default' })
  })

  it('surfaces a binding from the grandparent when nobody overrides it', () => {
    expect(resolvedMap().get('CloseContent')).toEqual({ chord: 'ctrl+f4', source: 'default' })
  })

  it('lets the nearer ancestor win over the further one', () => {
    // ReformatCode is ctrl+alt+L in $default and alt+meta+L in the mac keymap.
    expect(resolvedMap().get('ReformatCode')?.chord).toBe('alt+cmd+l')
  })

  it('lets the child override the parent, and marks it as the user’s', () => {
    expect(resolvedMap().get('EditorSelectWord')).toEqual({ chord: 'alt+up', source: 'user' })
  })

  it('suppresses the inherited binding when the child removes the action', () => {
    // The parent binds GotoDeclaration to meta B; the child empties the action.
    // The result is an explicit unbind rather than an absence, so the cell can
    // say "you removed this" instead of falling back to the inherited chord.
    expect(resolvedMap().get('GotoDeclaration')).toEqual({ chord: null, source: 'user' })
    expect(resolvedMap().get('ActivateTerminalToolWindow')).toEqual({
      chord: null,
      source: 'user'
    })
  })

  it('honours a removal made partway up the chain', () => {
    expect(resolvedMap().has('EditorToggleColumnMode')).toBe(false)
  })

  it('keeps child-only bindings that no ancestor mentions', () => {
    expect(resolvedMap().get('ShowSettings')).toEqual({ chord: 'cmd+,', source: 'user' })
  })

  it('leaves a child with no ancestors as its own bindings', () => {
    const resolved = resolveInheritance(child(), [])
    expect(resolved.map((b) => b.command).sort()).toEqual(
      child()
        .bindings.map((b) => b.command)
        .sort()
    )
  })
})

describe('merge', () => {
  it('round-trips byte-identically with nothing managed', () => {
    expect(merged(userKeymap, [])).toBe(userKeymap)
    expect(merged(parentKeymap, [])).toBe(parentKeymap)
  })

  it('round-trips byte-identically when the managed chords already hold', () => {
    expect(
      merged(userKeymap, [
        { command: 'SaveAll', chord: canonical('cmd+s') },
        { command: 'EditorSelectWord', chord: canonical('alt+up') },
        { command: 'GotoDeclaration', chord: null }
      ])
    ).toBe(userKeymap)
  })

  it('rewrites only the managed action', () => {
    const out = merged(userKeymap, [{ command: 'SaveAll', chord: canonical('ctrl+alt+s') }])
    expect(out).toContain('<keyboard-shortcut first-keystroke="ctrl alt S" />')
    expect(bindingFor(out, 'SaveAll')).toBe('ctrl+alt+s')
    // Everything else survives verbatim.
    expect(out.replace('ctrl alt S', 'meta S')).toBe(userKeymap)
  })

  it('preserves comments, mouse shortcuts, alternates and ordering', () => {
    const out = merged(userKeymap, [
      { command: 'GotoImplementation', chord: canonical('cmd+shift+i') },
      { command: 'ShowSettings', chord: canonical('cmd+shift+,') }
    ])
    expect(out).toContain('<!-- Saving. Kept on the same chord as everywhere else. -->')
    expect(out).toContain('<mouse-shortcut keystroke="alt button1" />')
    expect(out).toContain('<mouse-shortcut keystroke="shift button2" />')
    // The alternate keyboard shortcut is untouched, only the first is replaced.
    expect(out).toContain('<keyboard-shortcut first-keystroke="shift meta I"/>')
    expect(out).toContain('<keyboard-shortcut first-keystroke="shift meta I" />')
    expect(out.indexOf('SaveAll')).toBeLessThan(out.indexOf('EditorSelectWord'))
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
  })

  it('keeps the parent attribute when writing an override', () => {
    const out = merged(userKeymap, [{ command: 'ReformatCode', chord: canonical('cmd+alt+l') }])
    expect(out).toContain('<keymap version="1" name="macOS copy" parent="Mac OS X 10.5+">')
    // The inherited action arrives as one extra override element, nothing more.
    expect(out.match(/<action /g)?.length).toBe(userKeymap.match(/<action /g)!.length + 1)
  })

  it('writes an inherited action as a new override element, indented to match', () => {
    const out = merged(userKeymap, [
      { command: 'ActivateProjectToolWindow', chord: canonical('cmd+1') }
    ])
    expect(out).toContain(
      '  <action id="ActivateProjectToolWindow">\n    <keyboard-shortcut first-keystroke="meta 1" />\n  </action>\n</keymap>'
    )
    expect(bindingFor(out, 'ActivateProjectToolWindow')).toBe('cmd+1')
    // And the resolved view now shows the override rather than the parent's.
    const resolved = resolveInheritance(keymap(out), [keymap(parentKeymap)])
    expect(resolved.find((b) => b.command === 'ActivateProjectToolWindow')?.source).toBe('user')
  })

  it('unbinds an inherited action with an empty element rather than by omission', () => {
    const out = merged(userKeymap, [{ command: 'ReformatCode', chord: null }])
    expect(out).toContain('  <action id="ReformatCode" />')
    const resolved = resolveInheritance(keymap(out), [keymap(parentKeymap)])
    const reformat = resolved.find((b) => b.command === 'ReformatCode')
    expect(reformat).toMatchObject({ chord: null, negated: true })
  })

  it('unbinds an existing action by emptying it, not deleting it', () => {
    const out = merged(userKeymap, [{ command: 'SaveAll', chord: null }])
    expect(out).toContain('<action id="SaveAll" />')
    expect(out).not.toContain('first-keystroke="meta S"')
    expect(keymap(out).removed).toContain('SaveAll')
    // The preceding comment is not collateral damage.
    expect(out).toContain('<!-- Saving. Kept on the same chord as everywhere else. -->')
  })

  it('unbinds without destroying a mouse shortcut or the alternates', () => {
    const out = merged(userKeymap, [{ command: 'GotoImplementation', chord: null }])
    expect(out).toContain('<mouse-shortcut keystroke="alt button1" />')
    expect(out).not.toContain('alt meta B')
    expect(out).not.toContain('shift meta I')
    expect(out).toContain('<action id="GotoImplementation">')
    expect(keymap(out).removed).toContain('GotoImplementation')
  })

  it('adds a keyboard shortcut to an action that only had a mouse shortcut', () => {
    const out = merged(userKeymap, [
      { command: 'ActivateTerminalToolWindow', chord: canonical('alt+f12') }
    ])
    expect(out).toContain('<keyboard-shortcut first-keystroke="alt F12" />')
    expect(out).toContain('<mouse-shortcut keystroke="shift button2" />')
    expect(bindingFor(out, 'ActivateTerminalToolWindow')).toBe('alt+f12')
  })

  it('fills in an action that is present but empty', () => {
    const out = merged(userKeymap, [{ command: 'GotoDeclaration', chord: canonical('cmd+b') }])
    expect(out).toContain(
      '  <action id="GotoDeclaration">\n    <keyboard-shortcut first-keystroke="meta B" />\n  </action>'
    )
    expect(bindingFor(out, 'GotoDeclaration')).toBe('cmd+b')
  })

  it('writes two-keystroke chords as two attributes', () => {
    const out = merged(userKeymap, [
      {
        command: 'Refactorings.QuickListPopupAction',
        chord: chord(stroke('k', 'cmd'), stroke('s', 'cmd'))
      }
    ])
    expect(out).toContain('first-keystroke="meta K" second-keystroke="meta S"')
    expect(bindingFor(out, 'Refactorings.QuickListPopupAction')).toBe('cmd+k cmd+s')
  })

  it('reports inexpressible chords instead of writing them', () => {
    const bad = { strokes: [stroke('a', 'cmd'), stroke('b', 'cmd'), stroke('c', 'cmd')] }
    const outcome = jetbrainsAdapter.merge(userKeymap, [
      { command: 'SaveAll', chord: bad },
      { command: 'EditorSelectWord', chord: canonical('alt+down') }
    ])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('SaveAll')
    expect(outcome.contents).toContain('first-keystroke="meta S"')
    expect(outcome.contents).toContain('first-keystroke="alt DOWN"')
  })

  it('handles several managed bindings at once', () => {
    const out = merged(userKeymap, [
      { command: 'SaveAll', chord: canonical('cmd+shift+s') },
      { command: 'GotoDeclaration', chord: canonical('cmd+b') },
      { command: 'NextTab', chord: canonical('ctrl+tab') },
      { command: 'PreviousTab', chord: canonical('ctrl+shift+tab') },
      { command: 'ShowSettings', chord: null }
    ])
    expect(bindingFor(out, 'SaveAll')).toBe('shift+cmd+s')
    expect(bindingFor(out, 'GotoDeclaration')).toBe('cmd+b')
    expect(bindingFor(out, 'NextTab')).toBe('ctrl+tab')
    expect(bindingFor(out, 'PreviousTab')).toBe('ctrl+shift+tab')
    expect(keymap(out).removed).toContain('ShowSettings')
    expect(out).toContain('<mouse-shortcut keystroke="alt button1" />')
  })

  it('merges into freshly created empty contents', () => {
    const empty = jetbrainsAdapter.emptyContents()
    expect(jetbrainsAdapter.parse(empty).ok).toBe(true)
    expect(keymap(empty).parent).toBe('Mac OS X 10.5+')
    const out = merged(empty, [{ command: 'SaveAll', chord: canonical('cmd+s') }])
    expect(out).toBe(
      '<keymap version="1" name="unikeys" parent="Mac OS X 10.5+">\n' +
        '  <action id="SaveAll">\n' +
        '    <keyboard-shortcut first-keystroke="meta S" />\n' +
        '  </action>\n' +
        '</keymap>\n'
    )
    expect(merged(empty, [])).toBe(empty)
  })

  it('preserves CRLF line endings when inserting', () => {
    const crlf = userKeymap.replace(/\n/g, '\r\n')
    expect(merged(crlf, [])).toBe(crlf)
    const out = merged(crlf, [{ command: 'CloseContent', chord: canonical('cmd+w') }])
    expect(out).toContain('\r\n  <action id="CloseContent">\r\n')
    expect(out.includes('\n\n')).toBe(false)
  })

  it('escapes ids that would otherwise break the XML', () => {
    const out = merged(userKeymap, [{ command: 'A&B<C"', chord: canonical('cmd+j') }])
    expect(out).toContain('<action id="A&amp;B&lt;C&quot;">')
    expect(bindingFor(out, 'A&B<C"')).toBe('cmd+j')
  })

  it('refuses to touch malformed XML', () => {
    const outcome = jetbrainsAdapter.merge(malformed, [
      { command: 'SaveAll', chord: canonical('cmd+s') }
    ])
    expect(outcome.ok).toBe(false)
  })
})

describe('defaults', () => {
  it('reports partial coverage with an explanation', () => {
    const report = jetbrainsAdapter.defaults('webstorm')
    expect(report.availability).toBe('partial')
    expect(report.note).toMatch(/application bundle/)
    expect(report.bindings.length).toBeGreaterThan(20)
  })

  it('marks every default as a default and gives each a usable chord', () => {
    const report = jetbrainsAdapter.defaults('webstorm')
    for (const binding of report.bindings) {
      expect(binding.source).toBe('default')
      expect(jetbrainsAdapter.encodeChord(binding.chord!).ok).toBe(true)
    }
  })

  it('names no command twice', () => {
    const commands = jetbrainsAdapter.defaults('webstorm').bindings.map((b) => b.command)
    expect(new Set(commands).size).toBe(commands.length)
  })

  it('includes the bindings a JetBrains user would look for first', () => {
    const report = jetbrainsAdapter.defaults('webstorm')
    const found = new Map(report.bindings.map((b) => [b.command, formatCanonical(b.chord!)]))
    expect(found.get('SaveAll')).toBe('cmd+s')
    expect(found.get('GotoFile')).toBe('shift+cmd+o')
    expect(found.get('CommentByLineComment')).toBe('cmd+/')
    expect(found.get('Run')).toBe('ctrl+r')
    expect(found.get('ActivateTerminalToolWindow')).toBe('alt+f12')
    expect(found.get('EditorSelectWord')).toBe('alt+up')
    expect(found.get('NextSplitter')).toBe('alt+tab')
    expect(found.get('PrevSplitter')).toBe('alt+shift+tab')
  })

  it('gives IntelliJ IDEA and PyCharm the very same report as WebStorm', () => {
    // Every id in the table is a platform-level action, so a difference between
    // the three would be a bug rather than a fact about the IDEs.
    const webstorm = jetbrainsAdapter.defaults('webstorm')
    expect(jetbrainsAdapter.defaults('intellij')).toEqual(webstorm)
    expect(jetbrainsAdapter.defaults('pycharm')).toEqual(webstorm)
  })

  it('reports partial coverage for every IDE it serves', () => {
    for (const app of jetbrainsAdapter.apps) {
      const report = jetbrainsAdapter.defaults(app)
      expect(report.availability).toBe('partial')
      expect(report.bindings.length).toBeGreaterThan(20)
    }
  })

  it('explains itself without naming one IDE', () => {
    // The note sits above an IntelliJ or PyCharm column as readily as a
    // WebStorm one.
    expect(jetbrainsAdapter.defaults('intellij').note).not.toMatch(/WebStorm/)
  })

  it('claims nothing for an app it does not serve', () => {
    for (const app of ['vscode', 'ghostty'] as const) {
      const report = jetbrainsAdapter.defaults(app)
      expect(report.availability).toBe('unavailable')
      expect(report.bindings).toEqual([])
    }
  })

  it('is expressible as a keymap the adapter can read back', () => {
    const report = jetbrainsAdapter.defaults('webstorm')
    const out = merged(
      jetbrainsAdapter.emptyContents(),
      report.bindings.map((b) => ({ command: b.command, chord: b.chord }))
    )
    const reparsed = keymap(out)
    expect(reparsed.problems).toEqual([])
    expect(reparsed.bindings).toHaveLength(report.bindings.length)
    for (const binding of report.bindings) {
      expect(bindingFor(out, binding.command)).toBe(formatCanonical(binding.chord!))
    }
  })
})
