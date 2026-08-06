import { describe, expect, it } from 'vitest'
import {
  chord,
  chordsEqual,
  formatCanonical,
  formatDisplay,
  parseCanonical,
  stroke,
  strokeFromKeyEvent,
  type KeyEventLike
} from './chord'

describe('canonical serialisation', () => {
  it('orders modifiers the way macOS menus do, regardless of input order', () => {
    expect(formatCanonical(chord(stroke('p', 'cmd', 'shift')))).toBe('shift+cmd+p')
    expect(formatCanonical(chord(stroke('p', 'shift', 'cmd')))).toBe('shift+cmd+p')
    expect(formatCanonical(chord(stroke('a', 'cmd', 'ctrl', 'shift', 'alt')))).toBe(
      'ctrl+alt+shift+cmd+a'
    )
  })

  it('joins two keystrokes with a space', () => {
    expect(formatCanonical(chord(stroke('k', 'cmd'), stroke('s', 'cmd')))).toBe('cmd+k cmd+s')
  })

  it('round-trips through parse', () => {
    for (const text of [
      'cmd+s',
      'shift+cmd+p',
      'ctrl+alt+shift+cmd+a',
      'cmd+k cmd+s',
      'f5',
      'cmd+left'
    ]) {
      expect(formatCanonical(parseCanonical(text)!)).toBe(text)
    }
  })
})

describe('parsing chord text', () => {
  it('accepts modifier aliases', () => {
    const expected = 'alt+cmd+s'
    for (const text of ['cmd+alt+s', 'command+option+s', 'meta+opt+s', 'Cmd+Alt+S']) {
      expect(formatCanonical(parseCanonical(text)!)).toBe(expected)
    }
  })

  it('accepts the separator-free macOS symbol form a user would type', () => {
    expect(formatCanonical(parseCanonical('⌘⇧P')!)).toBe('shift+cmd+p')
    expect(formatCanonical(parseCanonical('⌃⌥⌘F')!)).toBe('ctrl+alt+cmd+f')
  })

  it('accepts hyphen as a separator', () => {
    expect(formatCanonical(parseCanonical('ctrl-alt-delete')!)).toBe('ctrl+alt+delete')
  })

  it('treats a trailing separator as the base key', () => {
    expect(formatCanonical(parseCanonical('cmd+-')!)).toBe('cmd+-')
    expect(formatCanonical(parseCanonical('cmd++')!)).toBe('cmd+=')
  })

  it('accepts named-key aliases', () => {
    expect(formatCanonical(parseCanonical('cmd+return')!)).toBe('cmd+enter')
    expect(formatCanonical(parseCanonical('esc')!)).toBe('escape')
    expect(formatCanonical(parseCanonical('cmd+arrowleft')!)).toBe('cmd+left')
  })

  it('refuses what it cannot represent rather than guessing', () => {
    expect(parseCanonical('')).toBeNull()
    expect(parseCanonical('cmd+')).toBeNull()
    expect(parseCanonical('cmd')).toBeNull() // modifier with no base key
    expect(parseCanonical('cmd+notakey')).toBeNull()
    expect(parseCanonical('cmd+a cmd+b cmd+c')).toBeNull() // more than two keystrokes
    expect(parseCanonical('a+cmd')).toBeNull() // modifier after base key
    expect(parseCanonical('cmd+a+b')).toBeNull() // two base keys
  })
})

describe('display rendering', () => {
  it('renders modifiers as the symbols shown in menus', () => {
    expect(formatDisplay(chord(stroke('p', 'cmd', 'shift')))).toBe('⇧⌘P')
    expect(formatDisplay(chord(stroke('s', 'ctrl', 'alt', 'shift', 'cmd')))).toBe('⌃⌥⇧⌘S')
  })

  it('renders named keys as their glyphs', () => {
    expect(formatDisplay(chord(stroke('enter', 'cmd')))).toBe('⌘↩')
    expect(formatDisplay(chord(stroke('left', 'alt')))).toBe('⌥←')
    expect(formatDisplay(chord(stroke('backspace', 'cmd')))).toBe('⌘⌫')
    expect(formatDisplay(chord(stroke('escape')))).toBe('⎋')
  })

  it('renders function keys and two-keystroke chords readably', () => {
    expect(formatDisplay(chord(stroke('f5', 'shift')))).toBe('⇧F5')
    expect(formatDisplay(chord(stroke('k', 'cmd'), stroke('s', 'cmd')))).toBe('⌘K ⌘S')
  })
})

describe('equality', () => {
  it('ignores modifier ordering', () => {
    expect(
      chordsEqual(chord(stroke('s', 'cmd', 'shift')), chord(stroke('s', 'shift', 'cmd')))
    ).toBe(true)
  })

  it('distinguishes different chords, and treats null as unbound', () => {
    expect(chordsEqual(chord(stroke('s', 'cmd')), chord(stroke('s', 'ctrl')))).toBe(false)
    expect(
      chordsEqual(chord(stroke('k', 'cmd')), chord(stroke('k', 'cmd'), stroke('s', 'cmd')))
    ).toBe(false)
    expect(chordsEqual(null, null)).toBe(true)
    expect(chordsEqual(null, chord(stroke('s', 'cmd')))).toBe(false)
  })
})

describe('capturing a real key press', () => {
  const press = (code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
    code,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    ...mods
  })

  it('builds a keystroke from the physical key and held modifiers', () => {
    expect(strokeFromKeyEvent(press('KeyP', { metaKey: true, shiftKey: true }))).toEqual({
      modifiers: ['shift', 'cmd'],
      key: 'p'
    })
    expect(strokeFromKeyEvent(press('BracketLeft', { metaKey: true }))).toEqual({
      modifiers: ['cmd'],
      key: '['
    })
    expect(strokeFromKeyEvent(press('ArrowRight', { altKey: true }))).toEqual({
      modifiers: ['alt'],
      key: 'right'
    })
  })

  it('uses the physical code, so ⌥1 is not captured as the character it produces', () => {
    // On macOS `event.key` for ⌥1 is "¡"; `event.code` is still Digit1.
    expect(strokeFromKeyEvent(press('Digit1', { altKey: true }))).toEqual({
      modifiers: ['alt'],
      key: '1'
    })
  })

  it('ignores a bare modifier press so holding ⌘ does not commit a chord', () => {
    expect(strokeFromKeyEvent(press('MetaLeft', { metaKey: true }))).toBeNull()
    expect(strokeFromKeyEvent(press('ShiftRight', { shiftKey: true }))).toBeNull()
  })

  it('returns null for keys unikeys cannot represent', () => {
    expect(strokeFromKeyEvent(press('MediaPlayPause'))).toBeNull()
  })
})
