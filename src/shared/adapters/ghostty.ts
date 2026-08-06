/**
 * The Ghostty adapter.
 *
 * Ghostty's config is a plain line-based file of `key = value` settings, where
 * bindings are `keybind = <trigger>=<action>` lines. There is no document
 * structure to preserve — which is exactly why this adapter edits **text**
 * rather than parsing to a model and reserialising. A user's config is full of
 * comments, deliberate blank lines and their own spacing habits, none of which
 * a reserialiser can reproduce, and all of which they would notice us
 * destroying.
 *
 * Because the format is line-based there is no whole-file failure mode: a
 * malformed line spoils that line and nothing else. `parse` therefore never
 * returns `ok: false`, and every bad line becomes a `ParseProblem`.
 */

import type { AppId } from '../apps'
import {
  CANONICAL_KEYS,
  canonicalKey,
  canonicalModifier,
  formatCanonical,
  MAX_STROKES,
  normalizeModifiers
} from '../chord'
import type { Chord, KeyStroke, Modifier } from '../chord'
import type {
  Adapter,
  DefaultsReport,
  EncodeOutcome,
  InexpressibleChord,
  ManagedBinding,
  MergeOutcome,
  ParseOutcome,
  ParseProblem,
  ParsedBinding
} from './types'

// ---------------------------------------------------------------------------
// Ghostty's key vocabulary
// ---------------------------------------------------------------------------

/**
 * Ghostty spells several keys as words. Only the spellings the canonical model
 * does not already accept need listing here; `canonicalKey` handles the rest,
 * including the literal punctuation characters a hand-written config may use.
 */
const GHOSTTY_KEY_ALIASES: Record<string, string> = {
  left_bracket: '[',
  right_bracket: ']',
  grave_accent: '`',
  numpad_enter: 'enter',
  // Digit words appear in older configs and Ghostty's own documentation.
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9'
}

/** Canonical key to the spelling Ghostty emits. Anything absent passes through. */
const GHOSTTY_KEY_NAMES: Record<string, string> = {
  '-': 'minus',
  '=': 'equal',
  '[': 'left_bracket',
  ']': 'right_bracket',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'apostrophe',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '`': 'grave_accent',
  pageup: 'page_up',
  pagedown: 'page_down'
}

const GHOSTTY_MODIFIER_NAMES: Record<Modifier, string> = {
  ctrl: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  cmd: 'cmd'
}

/** The action that means "remove whatever is bound to this trigger". */
const UNBIND = 'unbind'

/** The whole-file reset directive, written as `keybind = clear`. */
const CLEAR = 'clear'

const MANAGED_MARKER = '# Managed by unikeys'

// ---------------------------------------------------------------------------
// Chord translation
// ---------------------------------------------------------------------------

type DecodeResult = { ok: true; chord: Chord } | { ok: false; reason: string }

function decodeTrigger(text: string): DecodeResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, reason: 'empty trigger' }

  // A `:` in a trigger is always a prefix Ghostty understands and unikeys does
  // not (`global:`, `all:`, `unconsumed:`, `performable:`, `physical:`).
  // Silently dropping the prefix would claim a binding is plainer than it is,
  // so these are refused rather than misread.
  if (trimmed.includes(':')) {
    const prefix = trimmed.slice(0, trimmed.lastIndexOf(':') + 1)
    return { ok: false, reason: `trigger prefix \`${prefix}\` is not modelled` }
  }

  const parts = trimmed.split('>')
  if (parts.length > MAX_STROKES) {
    return { ok: false, reason: `sequences longer than ${MAX_STROKES} keystrokes are not modelled` }
  }

  const strokes: KeyStroke[] = []
  for (const part of parts) {
    const s = decodeStroke(part)
    if (!s) return { ok: false, reason: `unrecognised keystroke \`${part}\`` }
    strokes.push(s)
  }
  return { ok: true, chord: { strokes } }
}

function decodeStroke(text: string): KeyStroke | null {
  const tokens = tokenizeStroke(text.trim())
  if (tokens.length === 0) return null

  const modifiers: Modifier[] = []
  let key: string | null = null

  for (const token of tokens) {
    const mod = canonicalModifier(token)
    if (mod) {
      if (key !== null) return null
      modifiers.push(mod)
      continue
    }
    if (key !== null) return null
    const lower = token.toLowerCase()
    key = canonicalKey(GHOSTTY_KEY_ALIASES[lower] ?? lower)
    if (key === null) return null
  }

  if (key === null) return null
  return { modifiers: normalizeModifiers(modifiers), key }
}

/**
 * Splits `cmd+shift+d` into tokens. A `+` immediately after a separator is the
 * base key itself, which is what keeps `ctrl++` readable.
 */
function tokenizeStroke(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  for (const char of text) {
    if (char === '+' && current !== '') {
      tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

function encodeStroke(s: KeyStroke): EncodeOutcome {
  const key = s.key.toLowerCase()
  if (!CANONICAL_KEYS.has(key)) {
    return { ok: false, reason: `Ghostty has no key named \`${s.key}\`` }
  }
  const name = GHOSTTY_KEY_NAMES[key] ?? key
  const mods = normalizeModifiers(s.modifiers).map((m) => GHOSTTY_MODIFIER_NAMES[m])
  return { ok: true, value: [...mods, name].join('+') }
}

function encodeTrigger(c: Chord): EncodeOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'chord has no keystrokes' }
  if (c.strokes.length > MAX_STROKES) {
    return { ok: false, reason: `Ghostty sequences are limited to ${MAX_STROKES} keystrokes here` }
  }
  const parts: string[] = []
  for (const s of c.strokes) {
    const encoded = encodeStroke(s)
    if (!encoded.ok) return encoded
    parts.push(encoded.value)
  }
  return { ok: true, value: parts.join('>') }
}

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

/**
 * A source line and the exact terminator that followed it. Keeping the
 * terminator per line — rather than remembering "the file uses \n" — is what
 * lets a merge reproduce a file byte-for-byte including its final line's
 * missing newline.
 */
interface SourceLine {
  text: string
  /** `''` for a final line with no terminator. */
  eol: string
}

function splitLines(contents: string): SourceLine[] {
  const lines: SourceLine[] = []
  let i = 0
  while (i < contents.length) {
    const nl = contents.indexOf('\n', i)
    if (nl === -1) {
      lines.push({ text: contents.slice(i), eol: '' })
      break
    }
    const hasCr = nl > i && contents[nl - 1] === '\r'
    lines.push({ text: contents.slice(i, hasCr ? nl - 1 : nl), eol: hasCr ? '\r\n' : '\n' })
    i = nl + 1
  }
  return lines
}

function joinLines(lines: SourceLine[]): string {
  return lines.map((l) => l.text + l.eol).join('')
}

/** A parsed `keybind = ...` line, with enough text kept to rewrite it in place. */
interface KeybindLine {
  /** Everything up to and including the `=` and the spacing after it. */
  prefix: string
  trigger: string
  action: string
  /** Trailing whitespace, preserved so a rewrite does not reflow the line. */
  suffix: string
}

const KEYBIND_RE = /^(\s*keybind\s*=[ \t]*)(.*?)([ \t]*)$/

/**
 * Recognises a keybind line. Returns `null` for anything else, and a line with
 * an empty `action` for directives like `keybind = clear` that carry no `=`
 * inside their value.
 */
function readKeybindLine(text: string): KeybindLine | null {
  const match = text.match(KEYBIND_RE)
  if (!match) return null
  const [, prefix, value, suffix] = match
  const split = splitAtFirstUnescapedEquals(value)
  if (split === null) return { prefix, trigger: value, action: '', suffix }
  return { prefix, trigger: split[0], action: split[1], suffix }
}

/**
 * Actions routinely contain `:` and occasionally `=` (`text:x=1`), so only the
 * first unescaped `=` separates trigger from action; everything after it is
 * the action verbatim.
 */
function splitAtFirstUnescapedEquals(value: string): [string, string] | null {
  let backslashes = 0
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '\\') {
      backslashes++
      continue
    }
    if (char === '=' && backslashes % 2 === 0) return [value.slice(0, i), value.slice(i + 1)]
    backslashes = 0
  }
  return null
}

function renderKeybindLine(line: KeybindLine, trigger: string, action: string): string {
  return `${line.prefix}${trigger}=${action}${line.suffix}`
}

function isClearDirective(line: KeybindLine): boolean {
  return line.action === '' && line.trigger.trim() === CLEAR
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * The macOS defaults, transcribed from Ghostty's documentation. This is a
 * hand-authored table, not a reading of the installed app, so it is knowingly
 * incomplete — `defaults()` reports `partial` and says so.
 *
 * `toggle_quick_terminal` is deliberately absent: its default trigger carries a
 * `global:` prefix this adapter does not model, and listing it without the
 * prefix would describe a binding Ghostty does not actually have.
 */
const DEFAULT_TRIGGERS: Record<string, string> = {
  new_window: 'cmd+n',
  new_tab: 'cmd+t',
  close_surface: 'cmd+w',
  quit: 'cmd+q',
  'new_split:right': 'cmd+d',
  'new_split:down': 'cmd+shift+d',
  'goto_split:left': 'cmd+alt+left',
  'goto_split:right': 'cmd+alt+right',
  'goto_split:up': 'cmd+alt+up',
  'goto_split:down': 'cmd+alt+down',
  copy_to_clipboard: 'cmd+c',
  paste_from_clipboard: 'cmd+v',
  select_all: 'cmd+a',
  'increase_font_size:1': 'cmd+equal',
  'decrease_font_size:1': 'cmd+minus',
  reset_font_size: 'cmd+zero',
  toggle_fullscreen: 'cmd+ctrl+f',
  reload_config: 'cmd+shift+comma',
  clear_screen: 'cmd+k',
  next_tab: 'cmd+shift+right',
  previous_tab: 'cmd+shift+left',
  scroll_page_up: 'shift+page_up',
  scroll_page_down: 'shift+page_down'
}

const DEFAULTS_NOTE =
  'Ghostty defaults are transcribed from Ghostty’s documentation rather than read from the installed app, so the list is incomplete and may drift between releases.'

/** Canonical chord text to the action Ghostty binds it to by default. */
const COMMAND_BY_DEFAULT_CHORD: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [command, trigger] of Object.entries(DEFAULT_TRIGGERS)) {
    const decoded = decodeTrigger(trigger)
    if (decoded.ok) map.set(formatCanonical(decoded.chord), command)
  }
  return map
})()

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * True when the config contains `keybind = clear`, which discards every shipped
 * default. Exposed separately because the `Adapter` interface has no channel
 * for file-level facts that are neither a binding nor an error, and a caller
 * showing default chords needs to know they do not apply.
 */
export function ghosttyClearsDefaults(contents: string): boolean {
  return splitLines(contents).some((line) => {
    const kb = readKeybindLine(line.text)
    return kb !== null && isClearDirective(kb)
  })
}

function parseContents(contents: string): { bindings: ParsedBinding[]; problems: ParseProblem[] } {
  const bindings: ParsedBinding[] = []
  const problems: ParseProblem[] = []

  for (const line of splitLines(contents)) {
    const text = line.text
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const kb = readKeybindLine(text)
    if (!kb) {
      // Any other `key = value` setting is none of our business; a line with no
      // `=` at all is malformed and worth telling the user about.
      if (!trimmed.includes('=')) {
        problems.push({ message: 'Line is not a setting', detail: trimmed })
      }
      continue
    }

    if (isClearDirective(kb)) {
      // Surfaced as a problem because that is the only advisory channel the
      // interface offers today. It is information, not damage: the file is
      // fine, but the defaults unikeys would otherwise show are inert.
      problems.push({
        message: '`keybind = clear` discards Ghostty’s shipped default keybinds',
        detail: trimmed
      })
      continue
    }

    if (kb.action === '') {
      problems.push({ message: 'Keybind has no action', detail: trimmed })
      continue
    }

    const decoded = decodeTrigger(kb.trigger)
    if (!decoded.ok) {
      problems.push({ message: `Unreadable keybind: ${decoded.reason}`, detail: trimmed })
      continue
    }

    if (kb.action === UNBIND) {
      // An unbind names a trigger, not an action, so the only way to know what
      // it disables is to look up what Ghostty binds that trigger to.
      const command = COMMAND_BY_DEFAULT_CHORD.get(formatCanonical(decoded.chord))
      if (!command) {
        problems.push({
          message: 'Unbind targets a trigger with no known Ghostty default',
          detail: trimmed
        })
        continue
      }
      bindings.push({ command, chord: decoded.chord, source: 'user', negated: true })
      continue
    }

    bindings.push({ command: kb.action, chord: decoded.chord, source: 'user' })
  }

  return { bindings, problems }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

interface WorkingLine extends SourceLine {
  keybind: KeybindLine | null
  removed: boolean
}

function mergeContents(contents: string, managed: ManagedBinding[]): MergeOutcome {
  const source = splitLines(contents)
  const endedWithNewline = source.length > 0 && source[source.length - 1].eol !== ''
  const lines: WorkingLine[] = source.map((l) => ({
    ...l,
    keybind: readKeybindLine(l.text),
    removed: false
  }))

  const dominantEol = pickDominant(source.map((l) => l.eol).filter((e) => e !== '')) ?? '\n'
  const dominantPrefix =
    pickDominant(
      lines
        .filter((l) => l.keybind !== null && !isClearDirective(l.keybind!))
        .map((l) => l.keybind!.prefix.trimStart())
    ) ?? 'keybind = '

  const skipped: InexpressibleChord[] = []
  const appended: string[] = []

  for (const binding of managed) {
    const defaultTrigger = DEFAULT_TRIGGERS[binding.command] ?? null

    // Two kinds of line belong to a managed command: the line that binds it,
    // and any `unbind` of its default trigger that we previously wrote to keep
    // the default from resurfacing.
    const bound = lines.filter(
      (l) => !l.removed && l.keybind !== null && l.keybind.action === binding.command
    )
    const suppressions = lines.filter(
      (l) =>
        !l.removed &&
        l.keybind !== null &&
        l.keybind.action === UNBIND &&
        defaultTrigger !== null &&
        sameTrigger(l.keybind.trigger, defaultTrigger)
    )

    if (binding.chord === null) {
      // There is no trigger to unbind, so "unbound" means removing our line.
      // That alone is not enough when Ghostty ships a default for the action —
      // deleting the override just restores it — so the default trigger gets an
      // explicit `unbind` instead.
      for (const line of bound) line.removed = true
      if (defaultTrigger !== null && suppressions.length === 0) {
        appended.push(`${dominantPrefix}${defaultTrigger}=${UNBIND}`)
      }
      continue
    }

    const encoded = encodeTrigger(binding.chord)
    if (!encoded.ok) {
      skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
      continue
    }

    // The action is bound again, so any suppression we left behind is stale.
    for (const line of suppressions) line.removed = true

    if (bound.length === 0) {
      appended.push(`${dominantPrefix}${encoded.value}=${binding.command}`)
      continue
    }

    // Rewrite the first line in place and drop the rest: extra lines for the
    // same action are extra triggers that would still fire it, so leaving them
    // would mean the user's change only half took effect.
    const [first, ...extras] = bound
    first.text = renderKeybindLine(first.keybind!, encoded.value, binding.command)
    first.keybind = readKeybindLine(first.text)
    for (const line of extras) line.removed = true
  }

  const kept = lines
    .filter((l) => !l.removed)
    .map((l): SourceLine => ({ text: l.text, eol: l.eol }))
  const merged = appended.length === 0 ? kept : insertManaged(kept, appended, dominantEol)

  // Restore the file's trailing-newline state, which line removal or appending
  // may otherwise have flipped.
  if (merged.length > 0) {
    for (let i = 0; i < merged.length - 1; i++) {
      if (merged[i].eol === '') merged[i].eol = dominantEol
    }
    const last = merged[merged.length - 1]
    last.eol = endedWithNewline ? last.eol || dominantEol : ''
  }

  return { ok: true, contents: joinLines(merged), skipped }
}

function sameTrigger(a: string, b: string): boolean {
  const da = decodeTrigger(a)
  const db = decodeTrigger(b)
  if (!da.ok || !db.ok) return a.trim() === b.trim()
  return formatCanonical(da.chord) === formatCanonical(db.chord)
}

function pickDominant(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/**
 * Puts new lines under a clearly-marked section so a user reading their config
 * can tell at a glance which lines unikeys owns.
 */
function insertManaged(lines: SourceLine[], newTexts: string[], eol: string): SourceLine[] {
  const markerIndex = lines.findIndex((l) => l.text.trim() === MANAGED_MARKER)
  const additions = newTexts.map((text): SourceLine => ({ text, eol }))

  if (markerIndex === -1) {
    const spacer: SourceLine[] =
      lines.length > 0 && lines[lines.length - 1].text.trim() !== '' ? [{ text: '', eol }] : []
    return [...lines, ...spacer, { text: MANAGED_MARKER, eol }, ...additions]
  }

  // Extend the existing section rather than starting a second one.
  let insertAt = markerIndex + 1
  for (let i = markerIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i].text.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (readKeybindLine(lines[i].text) === null) break
    insertAt = i + 1
  }
  return [...lines.slice(0, insertAt), ...additions, ...lines.slice(insertAt)]
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const ghosttyAdapter: Adapter = {
  format: 'ghostty-config',
  apps: ['ghostty'],

  parse(contents: string): ParseOutcome {
    const { bindings, problems } = parseContents(contents)
    return {
      ok: true,
      bindings,
      problems,
      // A config carrying `keybind = clear` has thrown Ghostty's defaults away,
      // so the caller must not fill empty cells with them.
      defaultsSuppressed: ghosttyClearsDefaults(contents)
    }
  },

  merge(contents: string, managed: ManagedBinding[]): MergeOutcome {
    return mergeContents(contents, managed)
  },

  encodeChord(chord: Chord): EncodeOutcome {
    return encodeTrigger(chord)
  },

  decodeChord(text: string): Chord | null {
    const decoded = decodeTrigger(text)
    return decoded.ok ? decoded.chord : null
  },

  defaults(app: AppId): DefaultsReport {
    if (app !== 'ghostty') {
      return {
        availability: 'unavailable',
        note: `The Ghostty adapter has no defaults for ${app}.`,
        bindings: []
      }
    }
    const bindings: ParsedBinding[] = []
    for (const [command, trigger] of Object.entries(DEFAULT_TRIGGERS)) {
      const decoded = decodeTrigger(trigger)
      if (decoded.ok) bindings.push({ command, chord: decoded.chord, source: 'default' })
    }
    return { availability: 'partial', note: DEFAULTS_NOTE, bindings }
  },

  emptyContents(): string {
    return '# Ghostty configuration\n'
  }
}
