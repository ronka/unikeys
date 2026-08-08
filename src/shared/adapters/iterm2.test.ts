import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { chord, formatCanonical, parseCanonical, stroke, type Chord } from '../chord'
import { iterm2Adapter } from './iterm2'
import { entryKey, ITERM2_ACTION_IDS, UNIKEYS_PROFILE_GUID } from './iterm2-capture'
import type { ManagedBinding, MergeOutcome, ParseOutcome } from './types'

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/iterm2/${name}`, import.meta.url)),
    'utf8'
  )
}

/** The file a real iTerm2 3.6.11 was confirmed to act on. See the fixture README. */
const CAPTURED = fixture('captured-3.6.11.json')
const EMPTY_PROFILE = fixture('empty-profile.json')
const WITH_UNMANAGED = fixture('with-unmanaged.json')
const NO_PROFILES = fixture('no-profiles.json')
const MALFORMED = fixture('malformed.json')

function parsed(contents: string): Extract<ParseOutcome, { ok: true }> {
  const outcome = iterm2Adapter.parse(contents)
  if (!outcome.ok) throw new Error(`expected parse to succeed: ${outcome.error}`)
  return outcome
}

function merged(contents: string, managed: ManagedBinding[]): Extract<MergeOutcome, { ok: true }> {
  const outcome = iterm2Adapter.merge(contents, managed)
  if (!outcome.ok) throw new Error(`expected merge to succeed: ${outcome.error}`)
  return outcome
}

function keyMapOf(contents: string): Record<string, { Action: number; Text?: string }> {
  const parsedJson = JSON.parse(contents) as {
    Profiles: Array<{
      Guid?: string
      'Keyboard Map'?: Record<string, { Action: number; Text?: string }>
    }>
  }
  const profile = parsedJson.Profiles.find((p) => p.Guid === UNIKEYS_PROFILE_GUID)
  return profile?.['Keyboard Map'] ?? {}
}

function c(text: string): Chord {
  const value = parseCanonical(text)
  if (value === null) throw new Error(`bad test chord: ${text}`)
  return value
}

// ---------------------------------------------------------------------------

describe('the action table', () => {
  it('identifies every action uniquely', () => {
    // The whole design rests on `(Action, Text)` being an entry's identity: it is
    // how `parse` recognises unikeys' own bindings in a chord-keyed map. Two
    // tokens sharing a pair would make that lookup ambiguous.
    const identities = [...ITERM2_ACTION_IDS].map((token) => {
      const outcome = iterm2Adapter.merge(EMPTY_PROFILE, [{ command: token, chord: c('ctrl+f19') }])
      if (!outcome.ok) throw new Error(outcome.error)
      const entry = Object.values(keyMapOf(outcome.contents))[0]
      return entryKey({ action: entry.Action, text: entry.Text ?? '' })
    })
    expect(new Set(identities).size).toBe(identities.length)
  })
})

describe('encoding chords', () => {
  it('writes the two-part form iTerm2 still matches', () => {
    expect(iterm2Adapter.encodeChord(c('cmd+d'))).toEqual({ ok: true, value: '0x64-0x100000' })
    expect(iterm2Adapter.encodeChord(c('ctrl+cmd+u'))).toEqual({ ok: true, value: '0x75-0x140000' })
  })

  it('applies shift to the character as well as setting the shift bit', () => {
    // Verified against a running iTerm2: cmd+shift+D matched 0x44, not 0x64.
    expect(iterm2Adapter.encodeChord(c('cmd+shift+d'))).toEqual({
      ok: true,
      value: '0x44-0x120000'
    })
    expect(iterm2Adapter.encodeChord(c('cmd+shift+['))).toEqual({
      ok: true,
      value: '0x7b-0x120000'
    })
    expect(iterm2Adapter.encodeChord(c('cmd+shift+1'))).toEqual({
      ok: true,
      value: '0x21-0x120000'
    })
    // Shift+Tab is backtab, a character of its own.
    expect(iterm2Adapter.encodeChord(c('ctrl+shift+tab'))).toEqual({
      ok: true,
      value: '0x19-0x60000'
    })
  })

  it('sets the numeric-pad bit on arrows and on nothing else', () => {
    expect(iterm2Adapter.encodeChord(c('cmd+right'))).toEqual({
      ok: true,
      value: '0xf703-0x300000'
    })
    expect(iterm2Adapter.encodeChord(c('cmd+shift+left'))).toEqual({
      ok: true,
      value: '0xf702-0x320000'
    })
    // The trap: these look like arrows but carry no numeric-pad bit in iTerm2's
    // own shipped key map.
    expect(iterm2Adapter.encodeChord(c('cmd+home'))).toEqual({ ok: true, value: '0xf729-0x100000' })
    expect(iterm2Adapter.encodeChord(c('shift+pageup'))).toEqual({
      ok: true,
      value: '0xf72c-0x20000'
    })
  })

  it('refuses a two-keystroke chord rather than dropping half of it', () => {
    const outcome = iterm2Adapter.encodeChord(chord(stroke('k', 'cmd'), stroke('s', 'cmd')))
    expect(outcome).toEqual({ ok: false, reason: 'iTerm2 key mappings are a single keystroke' })
  })

  it('refuses a key it has no code for', () => {
    const outcome = iterm2Adapter.encodeChord(chord(stroke('mystery', 'cmd')))
    expect(outcome.ok).toBe(false)
  })
})

describe('decoding chords', () => {
  it('round-trips everything it encodes', () => {
    // Spelled in canonical modifier order (ctrl, alt, shift, cmd), which is what
    // `formatCanonical` emits.
    for (const text of [
      'cmd+d',
      'ctrl+cmd+u',
      'shift+cmd+d',
      'shift+cmd+[',
      'cmd+right',
      'shift+cmd+left',
      'cmd+home',
      'shift+pageup',
      'ctrl+shift+tab',
      'alt+f5',
      'cmd+space',
      'ctrl+alt+shift+cmd+9'
    ]) {
      const encoded = iterm2Adapter.encodeChord(c(text))
      if (!encoded.ok) throw new Error(`${text}: ${encoded.reason}`)
      const decoded = iterm2Adapter.decodeChord(encoded.value)
      expect(decoded === null ? null : formatCanonical(decoded), text).toBe(text)
    }
  })

  it('reads the legacy unprefixed form the app bundle still ships', () => {
    // 0x280000 is Option plus the numeric-pad bit every arrow carries.
    const decoded = iterm2Adapter.decodeChord('f702-0x280000')
    expect(decoded === null ? null : formatCanonical(decoded)).toBe('alt+left')
  })

  it('reads the three-part form iTerm2 own UI writes, ignoring the keycode', () => {
    const decoded = iterm2Adapter.decodeChord('0x7a-0x100000-0x6')
    expect(decoded === null ? null : formatCanonical(decoded)).toBe('cmd+z')
  })

  it('returns null for an unmodelled modifier bit rather than guessing', () => {
    expect(iterm2Adapter.decodeChord('0x64-0x1000000')).toBeNull()
  })

  it('returns null for a character it has no key for', () => {
    expect(iterm2Adapter.decodeChord('0xffff-0x100000')).toBeNull()
  })
})

describe('parsing', () => {
  it('reads unikeys bindings back out of a chord-keyed map', () => {
    const outcome = parsed(CAPTURED)
    const byCommand = Object.fromEntries(
      outcome.bindings.map((b) => [b.command, b.chord === null ? null : formatCanonical(b.chord)])
    )
    expect(byCommand).toEqual({
      'action:split-vertically': 'ctrl+cmd+u',
      'action:new-tab': 'ctrl+cmd+a',
      'menu:clear-buffer': 'ctrl+cmd+e'
    })
    expect(outcome.problems).toEqual([])
  })

  it('ignores entries it has no token for instead of reporting them', () => {
    // A user who hand-edits this file will have mappings unikeys does not model.
    // One problem each would flood the panel.
    const outcome = parsed(WITH_UNMANAGED)
    expect(outcome.bindings.map((b) => b.command)).toEqual(['action:split-vertically'])
    expect(outcome.problems).toEqual([])
  })

  it('treats a file with no unikeys profile as overriding nothing', () => {
    expect(parsed(NO_PROFILES)).toEqual({ ok: true, bindings: [], problems: [] })
    expect(parsed(EMPTY_PROFILE)).toEqual({ ok: true, bindings: [], problems: [] })
  })

  it('rejects a root that is not an object, as iTerm2 does', () => {
    const outcome = iterm2Adapter.parse(MALFORMED)
    expect(outcome.ok).toBe(false)
  })

  it('reports a malformed entry without losing the good ones', () => {
    const broken = CAPTURED.replace('"Action": 29', '"Action": "twenty-nine"')
    const outcome = parsed(broken)
    expect(outcome.bindings.map((b) => b.command)).toEqual(['action:new-tab', 'menu:clear-buffer'])
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0].message).toContain('has no numeric "Action"')
  })
})

describe('merging', () => {
  it('emits the bytes a real iTerm2 was confirmed to act on', () => {
    const outcome = merged(EMPTY_PROFILE, [
      { command: 'action:split-vertically', chord: c('ctrl+cmd+u') },
      { command: 'action:new-tab', chord: c('ctrl+cmd+a') },
      { command: 'menu:clear-buffer', chord: c('ctrl+cmd+e') }
    ])
    expect(outcome.contents).toBe(CAPTURED)
  })

  it('round-trips byte-identically when nothing has changed', () => {
    const same: ManagedBinding[] = [
      { command: 'action:split-vertically', chord: c('ctrl+cmd+u') },
      { command: 'action:new-tab', chord: c('ctrl+cmd+a') },
      { command: 'menu:clear-buffer', chord: c('ctrl+cmd+e') }
    ]
    expect(merged(CAPTURED, same).contents).toBe(CAPTURED)
    expect(merged(CAPTURED, []).contents).toBe(CAPTURED)
    expect(merged(WITH_UNMANAGED, []).contents).toBe(WITH_UNMANAGED)
  })

  it('moves a binding rather than leaving both keys mapped', () => {
    const outcome = merged(CAPTURED, [
      { command: 'action:split-vertically', chord: c('ctrl+cmd+j') }
    ])
    const map = keyMapOf(outcome.contents)
    expect(map['0x75-0x140000']).toBeUndefined()
    expect(map['0x6a-0x140000']).toEqual({ Action: 29, Text: UNIKEYS_PROFILE_GUID })
  })

  it('suppresses the shipped default so a moved binding does not fire twice', () => {
    // Verified live: without this, cmd+D still split after Split Right moved.
    const outcome = merged(EMPTY_PROFILE, [
      { command: 'action:split-vertically', chord: c('ctrl+cmd+u') }
    ])
    expect(keyMapOf(outcome.contents)['0x64-0x100000']).toEqual({ Action: 13, Text: '' })
  })

  it('does not suppress a default the user has bound to that very chord', () => {
    const outcome = merged(EMPTY_PROFILE, [
      { command: 'action:split-vertically', chord: c('cmd+d') }
    ])
    expect(keyMapOf(outcome.contents)['0x64-0x100000']).toEqual({
      Action: 29,
      Text: UNIKEYS_PROFILE_GUID
    })
  })

  it('removes the mapping for a null chord and suppresses the default', () => {
    const outcome = merged(CAPTURED, [{ command: 'action:split-vertically', chord: null }])
    const map = keyMapOf(outcome.contents)
    expect(map['0x75-0x140000']).toBeUndefined()
    expect(map['0x64-0x100000']).toEqual({ Action: 13, Text: '' })
  })

  it('leaves mappings unikeys does not manage exactly as it found them', () => {
    const outcome = merged(WITH_UNMANAGED, [
      { command: 'action:split-vertically', chord: c('ctrl+cmd+j') }
    ])
    // Including the members that carry keys unikeys does not model at all.
    expect(outcome.contents).toContain(
      '"f702-0x280000": { "Action": 11, "Text": "0x1b 0x1b 0x5b 0x44" }'
    )
    expect(outcome.contents).toContain('"Version": 1, "Label": "greet"')
    expect(outcome.contents).toContain('"Name": "Something else the user keeps here"')
  })

  it('reports a collision instead of silently dropping one binding', () => {
    const outcome = merged(EMPTY_PROFILE, [
      { command: 'action:split-vertically', chord: c('ctrl+cmd+u') },
      { command: 'action:new-tab', chord: c('ctrl+cmd+u') }
    ])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('action:new-tab')
    expect(outcome.skipped[0].reason).toContain('already uses this shortcut')
    expect(keyMapOf(outcome.contents)['0x75-0x140000']).toEqual({
      Action: 29,
      Text: UNIKEYS_PROFILE_GUID
    })
  })

  it('reports a collision with a binding this save is not touching', () => {
    // ⌃⌘U is Split Vertically in CAPTURED, and Split Vertically is not in this
    // save — so its entry survives and Copy cannot have the key. Reporting is
    // the whole point: silently dropping Copy while still suppressing its ⌘C
    // default would leave Copy bound to nothing at all.
    const outcome = merged(CAPTURED, [{ command: 'menu:copy', chord: c('ctrl+cmd+u') }])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].command).toBe('menu:copy')
    expect(outcome.skipped[0].reason).toContain('Split Vertically already uses this shortcut')
    // No Ignore on ⌘C, and nothing else moved.
    expect(keyMapOf(outcome.contents)['0x63-0x100000']).toBeUndefined()
    expect(outcome.contents).toBe(CAPTURED)
  })

  it('round-trips a binding written in iTerm2 own legacy spelling', () => {
    // The store says exactly what the file says, so this save must change
    // nothing — including not renormalising `f702-...` into `0xf702-...`.
    // New Tab on ⌥←, with ⌘T — the default it moved off — already suppressed,
    // so there is genuinely nothing for this save to add.
    const file = `{
  "Profiles": [
    { "Name": "unikeys", "Guid": "${UNIKEYS_PROFILE_GUID}",
      "Keyboard Map": {
        "f702-0x280000": { "Action": 27, "Text": "${UNIKEYS_PROFILE_GUID}" },
        "0x74-0x100000": { "Action": 13, "Text": "" }
      } }
  ]
}
`
    expect(parsed(file).bindings.map((b) => b.command)).toEqual(['action:new-tab'])
    const outcome = merged(file, [{ command: 'action:new-tab', chord: c('alt+left') }])
    expect(outcome.contents).toBe(file)
    expect(outcome.skipped).toEqual([])
  })

  it('sees a key already held under iTerm2 own legacy spelling', () => {
    // WITH_UNMANAGED holds ⌥← as `f702-0x280000`, the unprefixed form the app
    // bundle ships; unikeys writes that chord as `0xf702-0x280000`. Comparing
    // the two as text rather than as chords would add a second mapping for a
    // chord the user has already taken.
    const outcome = merged(WITH_UNMANAGED, [{ command: 'action:new-tab', chord: c('alt+left') }])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].reason).toContain('added by hand')
    expect(keyMapOf(outcome.contents)['0xf702-0x280000']).toBeUndefined()
  })

  it('swaps two managed bindings, because neither entry survives the save', () => {
    const outcome = merged(CAPTURED, [
      { command: 'action:split-vertically', chord: c('ctrl+cmd+a') },
      { command: 'action:new-tab', chord: c('ctrl+cmd+u') }
    ])
    expect(outcome.skipped).toEqual([])
    const map = keyMapOf(outcome.contents)
    expect(map['0x61-0x140000']).toEqual({ Action: 29, Text: UNIKEYS_PROFILE_GUID })
    expect(map['0x75-0x140000']).toEqual({ Action: 27, Text: UNIKEYS_PROFILE_GUID })
  })

  it('refuses a binding freed only by another binding that itself got refused', () => {
    // Clear Buffer wants ⌃⌘A, which New Tab is vacating — but New Tab wants
    // ⌃⌘U, which Split Vertically keeps. So New Tab stays put, ⌃⌘A is never
    // freed, and Clear Buffer has to be refused too. Deciding this in one pass
    // would write Clear Buffer onto a key New Tab still holds, producing a
    // Keyboard Map with the same key twice.
    const outcome = merged(CAPTURED, [
      { command: 'menu:clear-buffer', chord: c('ctrl+cmd+a') },
      { command: 'action:new-tab', chord: c('ctrl+cmd+u') }
    ])
    expect(outcome.skipped.map((s) => s.command).sort()).toEqual([
      'action:new-tab',
      'menu:clear-buffer'
    ])
    expect(outcome.contents).toBe(CAPTURED)
  })

  it('skips an inexpressible chord and leaves the file otherwise untouched', () => {
    const outcome = merged(CAPTURED, [
      { command: 'action:split-vertically', chord: chord(stroke('k', 'cmd'), stroke('s', 'cmd')) }
    ])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].reason).toBe('iTerm2 key mappings are a single keystroke')
    expect(keyMapOf(outcome.contents)['0x75-0x140000']).toEqual({
      Action: 29,
      Text: UNIKEYS_PROFILE_GUID
    })
  })

  it('skips a command it has no action for', () => {
    const outcome = merged(EMPTY_PROFILE, [{ command: 'action:nonsense', chord: c('cmd+d') }])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0].reason).toContain('not an iTerm2 action unikeys knows')
  })

  it('creates the profile when the file has a Profiles array but no unikeys entry', () => {
    const base = '{\n  "Profiles": []\n}\n'
    const outcome = merged(base, [{ command: 'action:next-tab', chord: c('ctrl+cmd+n') }])
    const profile = (JSON.parse(outcome.contents) as { Profiles: Array<{ Guid: string }> })
      .Profiles[0]
    expect(profile.Guid).toBe(UNIKEYS_PROFILE_GUID)
    expect(keyMapOf(outcome.contents)['0x6e-0x140000']).toEqual({ Action: 0, Text: '' })
  })

  it('writes a whole file from nothing', () => {
    const outcome = merged('', [{ command: 'action:next-tab', chord: c('ctrl+cmd+n') }])
    expect(keyMapOf(outcome.contents)['0x6e-0x140000']).toEqual({ Action: 0, Text: '' })
  })

  it('refuses to write over a root it does not understand', () => {
    expect(iterm2Adapter.merge(MALFORMED, []).ok).toBe(false)
    expect(iterm2Adapter.merge(NO_PROFILES, []).ok).toBe(false)
  })
})

describe('shipped defaults', () => {
  it('reports partial availability, because iTerm2 ships no profile key map', () => {
    const report = iterm2Adapter.defaults('iterm2')
    expect(report.availability).toBe('partial')
    expect(report.note).toBeDefined()
  })

  it('only names commands the action table knows', () => {
    for (const binding of iterm2Adapter.defaults('iterm2').bindings) {
      expect(ITERM2_ACTION_IDS.has(binding.command), binding.command).toBe(true)
    }
  })

  it('matches iTerm2 own shipped global key map for the tab pair', () => {
    // 0xf703-0x300000 -> Action 0, straight out of DefaultGlobalKeyMap.plist.
    const shipped = JSON.parse(fixture('default-global-key-map.json')) as Record<
      string,
      { Action: number }
    >
    expect(shipped['0xf703-0x300000'].Action).toBe(0)
    expect(shipped['0xf702-0x300000'].Action).toBe(2)

    const byCommand = Object.fromEntries(
      iterm2Adapter
        .defaults('iterm2')
        .bindings.map((b) => [b.command, b.chord === null ? null : formatCanonical(b.chord)])
    )
    expect(byCommand['action:next-tab']).toBe('cmd+right')
    expect(byCommand['action:previous-tab']).toBe('cmd+left')
  })

  it('has nothing to say about other apps', () => {
    expect(iterm2Adapter.defaults('ghostty')).toEqual({
      availability: 'unavailable',
      note: 'The iTerm2 adapter has no defaults for ghostty.',
      bindings: []
    })
  })
})
