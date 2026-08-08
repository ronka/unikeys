/**
 * The canonical chord model.
 *
 * Every app spells key combinations differently. unikeys holds exactly one
 * internal representation and each adapter translates to and from it, so
 * notation differences never leak into the store or the UI.
 *
 * A chord is a sequence of one or two keystrokes (VSCode and JetBrains both
 * support two-keystroke chords). A keystroke is a set of modifiers plus one
 * canonical base key.
 */

export const MODIFIERS = ['ctrl', 'alt', 'shift', 'cmd'] as const

/**
 * Modifiers are always held — and rendered — in Apple's menu order:
 * Control, Option, Shift, Command.
 */
export type Modifier = (typeof MODIFIERS)[number]

export interface KeyStroke {
  modifiers: Modifier[]
  /** A canonical base key: see `CANONICAL_KEYS`. Always lowercase. */
  key: string
}

export interface Chord {
  strokes: KeyStroke[]
}

/** Maximum keystrokes in a chord. Both VSCode and JetBrains cap at two. */
export const MAX_STROKES = 2

// ---------------------------------------------------------------------------
// Canonical key vocabulary
// ---------------------------------------------------------------------------

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')
const DIGITS = '0123456789'.split('')
const PUNCTUATION = ['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']
const NAMED = [
  'enter',
  'escape',
  'tab',
  'space',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right'
]
const FUNCTION_KEYS = Array.from({ length: 20 }, (_, i) => `f${i + 1}`)

export const CANONICAL_KEYS: ReadonlySet<string> = new Set([
  ...LETTERS,
  ...DIGITS,
  ...PUNCTUATION,
  ...NAMED,
  ...FUNCTION_KEYS
])

/**
 * Spellings that mean the same canonical key. Covers the notations the four
 * apps use plus what a user is likely to type into the text-entry fallback.
 */
const KEY_ALIASES: Record<string, string> = {
  // Enter / return
  return: 'enter',
  cr: 'enter',
  // Escape
  esc: 'escape',
  // Deletion. Note the platform split: on macOS the key labelled "delete" is
  // backspace. Apps disagree, so both spellings are accepted and each adapter
  // decides what to emit.
  del: 'delete',
  forwarddelete: 'delete',
  bs: 'backspace',
  // Paging
  pgup: 'pageup',
  pgdn: 'pagedown',
  page_up: 'pageup',
  page_down: 'pagedown',
  pgdown: 'pagedown',
  // Arrows
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  // Punctuation spelled as words
  minus: '-',
  plus: '=',
  '+': '=',
  equal: '=',
  equals: '=',
  comma: ',',
  period: '.',
  dot: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  apostrophe: "'",
  grave: '`',
  backquote: '`',
  backtick: '`',
  bracketleft: '[',
  bracketright: ']',
  open_bracket: '[',
  close_bracket: ']',
  left_bracket: '[',
  right_bracket: ']',
  grave_accent: '`',
  spacebar: 'space'
}

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  '⌘': 'cmd',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  '⌥': 'alt',
  shift: 'shift',
  '⇧': 'shift',
  ctrl: 'ctrl',
  control: 'ctrl',
  '⌃': 'ctrl'
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export const MODIFIER_SYMBOLS: Record<Modifier, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  cmd: '⌘'
}

const KEY_SYMBOLS: Record<string, string> = {
  enter: '↩',
  tab: '⇥',
  escape: '⎋',
  space: '␣',
  backspace: '⌫',
  delete: '⌦',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: '⇞',
  pagedown: '⇟',
  home: '↖',
  end: '↘',
  insert: '⌅'
}

// ---------------------------------------------------------------------------
// Construction and normalisation
// ---------------------------------------------------------------------------

/** Orders modifiers canonically and drops duplicates. */
export function normalizeModifiers(modifiers: readonly Modifier[]): Modifier[] {
  const present = new Set(modifiers)
  return MODIFIERS.filter((m) => present.has(m))
}

export function stroke(key: string, ...modifiers: Modifier[]): KeyStroke {
  return { modifiers: normalizeModifiers(modifiers), key: canonicalKey(key) ?? key }
}

export function chord(...strokes: KeyStroke[]): Chord {
  return { strokes }
}

/**
 * Resolves any accepted spelling of a key to its canonical name, or `null` if
 * the key is not one unikeys can represent.
 */
export function canonicalKey(raw: string): string | null {
  const lower = raw.trim().toLowerCase()
  if (lower === '') return null
  if (CANONICAL_KEYS.has(lower)) return lower
  const aliased = KEY_ALIASES[lower]
  if (aliased && CANONICAL_KEYS.has(aliased)) return aliased
  return null
}

export function canonicalModifier(raw: string): Modifier | null {
  return MODIFIER_ALIASES[raw.trim().toLowerCase()] ?? null
}

export function normalizeStroke(s: KeyStroke): KeyStroke {
  return { modifiers: normalizeModifiers(s.modifiers), key: s.key.toLowerCase() }
}

export function normalizeChord(c: Chord): Chord {
  return { strokes: c.strokes.map(normalizeStroke) }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export function strokesEqual(a: KeyStroke, b: KeyStroke): boolean {
  const na = normalizeStroke(a)
  const nb = normalizeStroke(b)
  return (
    na.key === nb.key &&
    na.modifiers.length === nb.modifiers.length &&
    na.modifiers.every((m, i) => m === nb.modifiers[i])
  )
}

export function chordsEqual(a: Chord | null, b: Chord | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.strokes.length === b.strokes.length &&
    a.strokes.every((s, i) => strokesEqual(s, b.strokes[i]))
  )
}

// ---------------------------------------------------------------------------
// Canonical serialisation — the form used in the persisted store
// ---------------------------------------------------------------------------

/**
 * Serialises to the store's on-disk form: `ctrl+alt+shift+cmd+key`, with
 * multiple keystrokes separated by a space (`cmd+k cmd+s`).
 *
 * This is unikeys' own notation, never an app's. Adapters serialise separately.
 */
export function formatCanonical(c: Chord): string {
  return c.strokes
    .map((s) => {
      const n = normalizeStroke(s)
      return [...n.modifiers, n.key].join('+')
    })
    .join(' ')
}

/**
 * Parses the canonical form, and doubles as the text-entry fallback: it accepts
 * any modifier alias, macOS symbols, and `-` or `+` as a separator, so a user
 * can type `⌘⇧P`, `cmd+shift+p`, or `Ctrl-Alt-Delete`.
 *
 * Returns `null` for anything it cannot represent, rather than guessing.
 */
export function parseCanonical(text: string): Chord | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  const strokeTexts = trimmed.split(/\s+/)
  if (strokeTexts.length === 0 || strokeTexts.length > MAX_STROKES) return null

  const strokes: KeyStroke[] = []
  for (const strokeText of strokeTexts) {
    const parsed = parseStrokeText(strokeText)
    if (!parsed) return null
    strokes.push(parsed)
  }
  return { strokes }
}

function parseStrokeText(text: string): KeyStroke | null {
  const tokens = tokenizeStroke(text)
  if (tokens.length === 0) return null

  const modifiers: Modifier[] = []
  let key: string | null = null

  for (const token of tokens) {
    const mod = canonicalModifier(token)
    if (mod) {
      // A modifier appearing after the base key is malformed.
      if (key !== null) return null
      modifiers.push(mod)
      continue
    }
    // Only one base key per keystroke.
    if (key !== null) return null
    key = canonicalKey(token)
    if (key === null) return null
  }

  if (key === null) return null
  return { modifiers: normalizeModifiers(modifiers), key }
}

/**
 * Splits a keystroke into tokens. Handles both separator styles and the
 * separator-free symbol form (`⌘⇧P`), while leaving `-`, `+` and `=` usable as
 * base keys (`cmd+-` and `cmd+plus` both work).
 */
function tokenizeStroke(text: string): string[] {
  const tokens: string[] = []
  let current = ''

  for (const char of text) {
    if (MODIFIER_ALIASES[char]) {
      // A macOS modifier symbol is self-delimiting.
      if (current !== '') tokens.push(current)
      tokens.push(char)
      current = ''
      continue
    }
    if ((char === '+' || char === '-') && current !== '') {
      // A separator only when it follows something. Immediately after another
      // separator it is the base key itself, which is what makes `cmd+-` and
      // `cmd++` work while `cmd+` stays incomplete.
      tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)

  return tokens
}

// ---------------------------------------------------------------------------
// Human-facing rendering
// ---------------------------------------------------------------------------

/**
 * Renders a chord with the macOS symbols the user sees in menus, so chords from
 * six apps can be compared without mentally translating six notations.
 */
export function formatDisplay(c: Chord): string {
  return c.strokes.map(formatStrokeDisplay).join(' ')
}

export function formatStrokeDisplay(s: KeyStroke): string {
  const n = normalizeStroke(s)
  const mods = n.modifiers.map((m) => MODIFIER_SYMBOLS[m]).join('')
  return mods + displayKey(n.key)
}

function displayKey(key: string): string {
  const symbol = KEY_SYMBOLS[key]
  if (symbol) return symbol
  if (key.length === 1) return key.toUpperCase()
  // Function keys and anything else render as an uppercased word.
  return key.toUpperCase()
}

// ---------------------------------------------------------------------------
// Keyboard capture
// ---------------------------------------------------------------------------

/**
 * The subset of a DOM `KeyboardEvent` chord capture needs. Declared as a plain
 * shape so the conversion stays pure and testable without a browser.
 */
export interface KeyEventLike {
  /** `KeyboardEvent.code`, e.g. `KeyA`, `Digit1`, `BracketLeft`, `Escape`. */
  code: string
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
}

const CODE_PREFIXES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Key([A-Z])$/, (m) => m[1].toLowerCase()],
  [/^Digit([0-9])$/, (m) => m[1]],
  [/^Numpad([0-9])$/, (m) => m[1]],
  [/^(F\d{1,2})$/, (m) => m[1].toLowerCase()]
]

const CODE_KEYS: Record<string, string> = {
  Escape: 'escape',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Space: 'space',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

/** Codes that are modifiers themselves and can never be a base key. */
const MODIFIER_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'CapsLock'
])

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

/**
 * Converts a captured key press into a keystroke, or `null` if the press was a
 * bare modifier or a key unikeys cannot represent.
 *
 * Uses `code` rather than `key` deliberately: `key` is affected by the active
 * modifiers on macOS (⌥1 reports `¡`), which would produce nonsense chords.
 */
export function strokeFromKeyEvent(event: KeyEventLike): KeyStroke | null {
  if (isModifierCode(event.code)) return null

  let key = CODE_KEYS[event.code] ?? null
  if (key === null) {
    for (const [pattern, extract] of CODE_PREFIXES) {
      const match = event.code.match(pattern)
      if (match) {
        key = extract(match)
        break
      }
    }
  }
  if (key === null || !CANONICAL_KEYS.has(key)) return null

  const modifiers: Modifier[] = []
  if (event.ctrlKey) modifiers.push('ctrl')
  if (event.altKey) modifiers.push('alt')
  if (event.shiftKey) modifiers.push('shift')
  if (event.metaKey) modifiers.push('cmd')

  return { modifiers: normalizeModifiers(modifiers), key }
}
