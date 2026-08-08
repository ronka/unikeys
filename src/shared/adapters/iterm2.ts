/**
 * iTerm2, via a Dynamic Profile.
 *
 * **Why not iTerm2's real preferences.** iTerm2 keeps its key bindings in
 * `~/Library/Preferences/com.googlecode.iterm2.plist`, which is a *binary*
 * plist — and this adapter seam, along with the file layer above it, is defined
 * over strings. iTerm2 also rewrites that file from memory when it quits, so an
 * external edit made while it runs is silently thrown away. Either fact on its
 * own rules the prefs file out as a write target.
 *
 * So unikeys writes a **Dynamic Profile** instead: a plain-JSON file it owns at
 * `~/Library/Application Support/iTerm2/DynamicProfiles/unikeys.json`, which
 * iTerm2 watches and reloads live. That is iTerm2's sanctioned integration
 * point for external tools.
 *
 * **The caveat that matters.** A Dynamic Profile defines a *new* profile rather
 * than editing the user's. `Dynamic Profile Parent Name` makes it inherit
 * everything else from theirs, but iTerm2 offers no way for a dynamic profile to
 * declare itself the default — `"Default Bookmark": "Yes"` was tested against
 * 3.6.11 and does nothing. So the user must select the profile once. That is
 * what `APPS.iterm2.reloadHint` says, and it is the one thing about this column
 * that differs from every other one.
 *
 * **The inverted map.** Every other format unikeys writes is keyed by the app's
 * command. iTerm2's `Keyboard Map` is keyed by the *chord*, with the action as
 * the value — so a binding's identity here is its `(Action, Text)` pair, and
 * changing a chord means removing one member and adding another rather than
 * editing a value in place. `TOKEN_BY_ENTRY` is the reverse lookup that makes
 * that work, and it is only well defined because `ITERM2_ACTIONS` is injective
 * on `(action, text)` — there is a test pinning that.
 *
 * **Merge granularity.** Because entries move rather than change, `merge`
 * rewrites the whole `Keyboard Map` node in one edit instead of splicing
 * members individually; deleting object members by span needs three different
 * comma rules and produces overlapping edits when neighbours both go. Ordering
 * of unikeys' own entries is therefore not preserved — acceptable only because
 * unikeys owns this file, which is not true of Ghostty's or cmux's config.
 * Entries unikeys does not manage are carried across **verbatim from source**,
 * so a hand-added mapping keeps any `Version`, `Label` or `Escaping` key it
 * came with. When nothing has changed, `merge` emits no edits at all and the
 * file round-trips byte for byte.
 *
 * Every constant below was captured from iTerm2 3.6.11 — the action integers
 * from `sources/iTermKeyBindingAction.h` cross-checked against all 14 bindings
 * shipped in the app bundle's `DefaultGlobalKeyMap.plist` and
 * `PresetKeyMappings.plist`, the key encoding and the menu-item parameter shape
 * by driving the running app, and the menu titles and identifiers by walking its
 * menu bar. See `__fixtures__/iterm2/README.md`.
 */

import type { AppId } from '../apps'
import {
  MAX_STROKES,
  type Chord,
  type KeyStroke,
  type Modifier,
  normalizeStroke,
  parseCanonical
} from '../chord'
import {
  applyEdits,
  excerpt,
  indentOfLineAt,
  member,
  readDocument,
  stringMember,
  type Edit,
  type JsoncNode,
  type Member,
  type ObjectNode,
  type Span
} from './jsonc'
import type {
  Adapter,
  DefaultsReport,
  InexpressibleChord,
  ManagedBinding,
  MergeOutcome,
  ParseOutcome,
  ParseProblem,
  ParsedBinding,
  EncodeOutcome
} from './types'

// ---------------------------------------------------------------------------
// The profile unikeys owns
// ---------------------------------------------------------------------------

/**
 * Fixed, never generated at runtime. A fresh Guid per write would make iTerm2
 * treat each save as a different profile, orphaning the previous one and losing
 * whichever one the user had selected.
 */
export const UNIKEYS_PROFILE_GUID = '7B8E4F2A-3C6D-4E19-9A05-1D2F8C4B6E30'
const UNIKEYS_PROFILE_NAME = 'unikeys'
const PARENT_PROFILE_NAME = 'Default'

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * iTerm2's `KEY_ACTION_*` values. Identical at tags v3.5.0 and v3.6.0, and every
 * one of these reproduces the shipped-plist bindings in the 3.6.11 bundle.
 */
const NEXT_SESSION = 0
const PREVIOUS_SESSION = 2
const SELECT_PANE_LEFT = 18
const SELECT_PANE_RIGHT = 19
const SELECT_PANE_ABOVE = 20
const SELECT_PANE_BELOW = 21
const TOGGLE_FULLSCREEN = 23
const SELECT_MENU_ITEM = 25
const NEW_WINDOW_WITH_PROFILE = 26
const NEW_TAB_WITH_PROFILE = 27
const SPLIT_HORIZONTALLY_WITH_PROFILE = 28
const SPLIT_VERTICALLY_WITH_PROFILE = 29
const NEXT_PANE = 30
const PREVIOUS_PANE = 31

interface ItermEntry {
  action: number
  /**
   * iTerm2's parameter. Empty for actions that take none; a profile Guid for the
   * `*_WITH_PROFILE` actions (there is no "current profile" sentinel — an
   * unknown Guid renders as "with unavailable Profile", so unikeys passes its
   * own, which also makes new tabs and splits inherit these bindings); and
   * `"<title>\n<identifier>"` for `SELECT_MENU_ITEM`.
   */
  text: string
  /** Human-readable, for problem and skip messages. */
  label: string
}

/** `"<title>\n<identifier>"`, the parameter `SELECT_MENU_ITEM` looks a menu item up by. */
function menuItem(title: string, identifier: string = title): string {
  return `${title}\n${identifier}`
}

/**
 * The vocabulary `catalogue.json` maps to in its `iterm2` field.
 *
 * iTerm2 has no textual command names of its own, so unikeys invents stable
 * tokens: `action:` for a first-class key action, `menu:` for one driven through
 * `SELECT_MENU_ITEM`. Menu titles live here and never in the catalogue, so a
 * title correction — or a localisation fix — is a one-line change here rather
 * than a catalogue migration.
 */
const ITERM2_ACTIONS: Record<string, ItermEntry> = {
  'action:next-tab': { action: NEXT_SESSION, text: '', label: 'Next Tab' },
  'action:previous-tab': { action: PREVIOUS_SESSION, text: '', label: 'Previous Tab' },
  'action:toggle-fullscreen': { action: TOGGLE_FULLSCREEN, text: '', label: 'Toggle Fullscreen' },

  // "Split Vertically" puts the new session in the right half, "Split
  // Horizontally" in the bottom half — iTerm2 names the divider, unikeys names
  // where the pane lands, so these two read backwards on purpose.
  'action:split-vertically': {
    action: SPLIT_VERTICALLY_WITH_PROFILE,
    text: UNIKEYS_PROFILE_GUID,
    label: 'Split Vertically'
  },
  'action:split-horizontally': {
    action: SPLIT_HORIZONTALLY_WITH_PROFILE,
    text: UNIKEYS_PROFILE_GUID,
    label: 'Split Horizontally'
  },
  'action:new-tab': {
    action: NEW_TAB_WITH_PROFILE,
    text: UNIKEYS_PROFILE_GUID,
    label: 'New Tab'
  },
  'action:new-window': {
    action: NEW_WINDOW_WITH_PROFILE,
    text: UNIKEYS_PROFILE_GUID,
    label: 'New Window'
  },

  'action:select-pane-left': { action: SELECT_PANE_LEFT, text: '', label: 'Select Pane Left' },
  'action:select-pane-right': { action: SELECT_PANE_RIGHT, text: '', label: 'Select Pane Right' },
  'action:select-pane-above': { action: SELECT_PANE_ABOVE, text: '', label: 'Select Pane Above' },
  'action:select-pane-below': { action: SELECT_PANE_BELOW, text: '', label: 'Select Pane Below' },
  'action:next-pane': { action: NEXT_PANE, text: '', label: 'Select Next Pane' },
  'action:previous-pane': { action: PREVIOUS_PANE, text: '', label: 'Select Previous Pane' },

  'menu:close': { action: SELECT_MENU_ITEM, text: menuItem('Close'), label: 'Close' },
  'menu:copy': { action: SELECT_MENU_ITEM, text: menuItem('Copy'), label: 'Copy' },
  'menu:paste': { action: SELECT_MENU_ITEM, text: menuItem('Paste'), label: 'Paste' },
  'menu:select-all': {
    action: SELECT_MENU_ITEM,
    text: menuItem('Select All'),
    label: 'Select All'
  },
  'menu:clear-buffer': {
    action: SELECT_MENU_ITEM,
    text: menuItem('Clear Buffer'),
    label: 'Clear Buffer'
  },
  'menu:make-text-bigger': {
    action: SELECT_MENU_ITEM,
    text: menuItem('Make Text Bigger'),
    label: 'Make Text Bigger'
  },
  'menu:make-text-smaller': {
    action: SELECT_MENU_ITEM,
    text: menuItem('Make Text Smaller'),
    label: 'Make Text Smaller'
  },
  'menu:make-text-normal-size': {
    action: SELECT_MENU_ITEM,
    text: menuItem('Make Text Normal Size'),
    label: 'Make Text Normal Size'
  }
}

export const ITERM2_ACTION_IDS: ReadonlySet<string> = new Set(Object.keys(ITERM2_ACTIONS))

/**
 * The identity of an entry: its action and parameter, NUL-separated.
 *
 * NUL rather than a space because the action is a bare number and the
 * parameter is arbitrary text, so a printable separator would let
 * `(2, "9 foo")` and `(29, "foo")` collide.
 */
export function entryKey(entry: { action: number; text: string }): string {
  return `${entry.action}\u0000${entry.text}`
}

const TOKEN_BY_ENTRY: ReadonlyMap<string, string> = new Map(
  Object.entries(ITERM2_ACTIONS).map(([token, entry]) => [entryKey(entry), token])
)

// ---------------------------------------------------------------------------
// Key encoding
// ---------------------------------------------------------------------------

const FLAG_SHIFT = 0x20000
const FLAG_CONTROL = 0x40000
const FLAG_OPTION = 0x80000
const FLAG_COMMAND = 0x100000
/** Arrow keys carry this; nothing else unikeys emits does. */
const FLAG_NUMERIC_PAD = 0x200000

const KNOWN_FLAGS = FLAG_SHIFT | FLAG_CONTROL | FLAG_OPTION | FLAG_COMMAND | FLAG_NUMERIC_PAD

interface ItermKey {
  char: number
  /**
   * The character iTerm2 records when Shift is held. iTerm2 stores
   * `charactersIgnoringModifiers`, which still applies Shift — ⌘⇧D is recorded
   * as `0x44` ('D'), not `0x64` ('d'), and ⌘⇧[ as `0x7b` ('{'). Keys with no
   * shifted form keep `char` and simply carry the Shift flag.
   */
  shifted?: number
  numericPad?: true
}

const SHIFTED_DIGITS = ')!@#$%^&*('
const SHIFTED_PUNCTUATION: Record<string, string> = {
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
  '`': '~'
}

const ITERM2_KEYS: Record<string, ItermKey> = (() => {
  const keys: Record<string, ItermKey> = {}

  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    keys[letter] = { char: letter.charCodeAt(0), shifted: letter.toUpperCase().charCodeAt(0) }
  }
  for (let digit = 0; digit <= 9; digit++) {
    keys[String(digit)] = {
      char: '0'.charCodeAt(0) + digit,
      shifted: SHIFTED_DIGITS.charCodeAt(digit)
    }
  }
  for (const [key, shifted] of Object.entries(SHIFTED_PUNCTUATION)) {
    keys[key] = { char: key.charCodeAt(0), shifted: shifted.charCodeAt(0) }
  }

  // Shift+Tab is backtab, a character in its own right — the shipped global key
  // map binds `0x19-0x60000` for ⌃⇧Tab.
  keys.tab = { char: 0x9, shifted: 0x19 }
  keys.enter = { char: 0xd }
  keys.escape = { char: 0x1b }
  keys.space = { char: 0x20 }
  // The macOS split `chord.ts` documents: the key labelled "delete" on a Mac is
  // backspace (0x7f), and forward-delete is the function key 0xf728.
  keys.backspace = { char: 0x7f }
  keys.delete = { char: 0xf728 }
  keys.insert = { char: 0xf727 }
  keys.home = { char: 0xf729 }
  keys.end = { char: 0xf72b }
  keys.pageup = { char: 0xf72c }
  keys.pagedown = { char: 0xf72d }

  keys.up = { char: 0xf700, numericPad: true }
  keys.down = { char: 0xf701, numericPad: true }
  keys.left = { char: 0xf702, numericPad: true }
  keys.right = { char: 0xf703, numericPad: true }

  for (let n = 1; n <= 20; n++) keys[`f${n}`] = { char: 0xf704 + n - 1 }

  return keys
})()

const KEY_BY_CHAR: ReadonlyMap<number, string> = new Map(
  Object.entries(ITERM2_KEYS).map(([name, key]) => [key.char, name])
)
const KEY_BY_SHIFTED_CHAR: ReadonlyMap<number, string> = new Map(
  Object.entries(ITERM2_KEYS)
    .filter(([, key]) => key.shifted !== undefined)
    .map(([name, key]) => [key.shifted as number, name])
)

function encodeChord(c: Chord): EncodeOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'the chord has no keystrokes' }
  if (c.strokes.length > 1) {
    // Reachable: MAX_STROKES is 2, and a linked row can propagate a VSCode or
    // JetBrains two-keystroke chord straight into this column.
    return { ok: false, reason: 'iTerm2 key mappings are a single keystroke' }
  }

  const s = normalizeStroke(c.strokes[0])
  const key = ITERM2_KEYS[s.key]
  if (key === undefined) return { ok: false, reason: `iTerm2 has no key named "${s.key}"` }

  const held = new Set<Modifier>(s.modifiers)
  const char = held.has('shift') && key.shifted !== undefined ? key.shifted : key.char

  let mask = 0
  if (held.has('shift')) mask |= FLAG_SHIFT
  if (held.has('ctrl')) mask |= FLAG_CONTROL
  if (held.has('alt')) mask |= FLAG_OPTION
  if (held.has('cmd')) mask |= FLAG_COMMAND
  if (key.numericPad) mask |= FLAG_NUMERIC_PAD

  return { ok: true, value: `0x${char.toString(16)}-0x${mask.toString(16)}` }
}

/**
 * Accepts every form iTerm2 has written. The `0x` prefixes are optional because
 * the bundle's own `PresetKeyMappings.plist` ships unprefixed keys, and a third
 * component is tolerated and ignored because iTerm2's own UI writes a virtual
 * keycode there. `encodeChord` only ever emits the two-part prefixed form, which
 * current iTerm2 still matches through its legacy lookup path.
 */
const KEY_PATTERN = /^(?:0x)?([0-9a-f]+)-(?:0x)?([0-9a-f]+)(?:-(?:0x)?[0-9a-f]+)?$/i

function decodeChord(text: string): Chord | null {
  const match = KEY_PATTERN.exec(text.trim())
  if (match === null) return null

  const char = parseInt(match[1], 16)
  const mask = parseInt(match[2], 16)
  if (!Number.isFinite(char) || !Number.isFinite(mask)) return null
  // An unmodelled flag means unikeys does not understand this binding. Guessing
  // would put a chord in the cell that does not match what iTerm2 will fire.
  if ((mask & ~KNOWN_FLAGS) !== 0) return null

  const shifted = (mask & FLAG_SHIFT) !== 0
  // With Shift held the character is the shifted one, so that reading comes
  // first; without it, the plain reading does. Each falls back to the other so a
  // hand-written entry that disagrees still decodes.
  const key = shifted
    ? (KEY_BY_SHIFTED_CHAR.get(char) ?? KEY_BY_CHAR.get(char))
    : (KEY_BY_CHAR.get(char) ?? KEY_BY_SHIFTED_CHAR.get(char))
  if (key === undefined) return null

  const modifiers: Modifier[] = []
  if ((mask & FLAG_CONTROL) !== 0) modifiers.push('ctrl')
  if ((mask & FLAG_OPTION) !== 0) modifiers.push('alt')
  if (shifted) modifiers.push('shift')
  if ((mask & FLAG_COMMAND) !== 0) modifiers.push('cmd')

  const strokes: KeyStroke[] = [{ modifiers, key }]
  return { strokes }
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * What iTerm2 3.6.11 binds these actions to out of the box.
 *
 * Two sources, neither of them the profile key map: the app bundle's
 * `DefaultGlobalKeyMap.plist` for the tab-navigation pair, and iTerm2's menu bar
 * — captured by walking it — for the rest. iTerm2 ships an *empty* profile key
 * map (`DefaultBookmark.plist`), so there is no third source and no way to make
 * this table complete.
 *
 * Deliberately absent: `action:toggle-fullscreen`, whose menu entry reports a
 * modifier mask unikeys could not read unambiguously, and the four directional
 * pane-focus actions, which live in a third-level submenu the capture did not
 * reach. An absent entry means "not captured", never "iTerm2 leaves it unbound".
 */
const DEFAULT_CHORDS: Record<string, string> = {
  'action:next-tab': 'cmd+right',
  'action:previous-tab': 'cmd+left',
  'action:split-vertically': 'cmd+d',
  'action:split-horizontally': 'cmd+shift+d',
  'action:new-tab': 'cmd+t',
  'action:new-window': 'cmd+n',
  'menu:close': 'cmd+w',
  'menu:copy': 'cmd+c',
  'menu:paste': 'cmd+v',
  'menu:select-all': 'cmd+a',
  'menu:clear-buffer': 'cmd+k',
  // iTerm2's menu shows ⌘+, but + is a shifted key: the press that fires it is
  // ⇧⌘=, which encodes to 0x2b-0x120000. Spelling this `cmd+=` would put an
  // Ignore on 0x3d-0x100000 — a key iTerm2 never uses — and leave ⌘+ still
  // enlarging the text after the user had moved the binding. Verified by press.
  'menu:make-text-bigger': 'shift+cmd+=',
  'menu:make-text-smaller': 'cmd+-',
  'menu:make-text-normal-size': 'cmd+0'
}

const DEFAULTS_NOTE =
  'iTerm2 ships an empty profile key map, so these defaults are captured from iTerm2 3.6.11’s ' +
  'global key map and menu bar — two surfaces unikeys does not write. Toggle Full Screen and the ' +
  'directional pane-focus actions are not captured. Changing a cell suppresses the one default ' +
  'chord recorded here, so an action iTerm2 also binds elsewhere may still answer its other key.'

/**
 * The chord iTerm2 ships for a token, encoded as a `Keyboard Map` key — or
 * `null` when there is no captured default.
 */
function defaultEncodedKey(token: string): string | null {
  const canonical = DEFAULT_CHORDS[token]
  if (canonical === undefined) return null
  const chord = parseCanonical(canonical)
  if (chord === null) return null
  const encoded = encodeChord(chord)
  return encoded.ok ? encoded.value : null
}

/**
 * Suppressing a shipped default: iTerm2's own `{Action: 13}` (Ignore), which is
 * how unikeys stops ⌘D still splitting after the user has moved Split Right to
 * something else. Without it a profile key map only ever *adds* bindings, and a
 * changed cell would leave the original key working too — the same gap Ghostty's
 * `unbind` and VSCode's `-command` entries exist to close.
 */
const IGNORE_ENTRY: ItermEntry = { action: 13, text: '', label: 'Ignore' }

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

/** The profile unikeys owns: by Guid, or by name for a file whose Guid was edited. */
function unikeysProfile(root: JsoncNode | null): ObjectNode | null {
  if (root === null || root.kind !== 'object') return null
  const profiles = member(root, 'Profiles')
  if (profiles === undefined || profiles.value.kind !== 'array') return null

  let byName: ObjectNode | null = null
  for (const item of profiles.value.items) {
    if (item.kind !== 'object') continue
    if (stringMember(item, 'Guid')?.value === UNIKEYS_PROFILE_GUID) return item
    if (byName === null && stringMember(item, 'Name')?.value === UNIKEYS_PROFILE_NAME) byName = item
  }
  return byName
}

function keyboardMap(profile: ObjectNode | null): ObjectNode | null {
  if (profile === null) return null
  const map = member(profile, 'Keyboard Map')
  return map !== undefined && map.value.kind === 'object' ? map.value : null
}

interface ReadEntry {
  /** The `Keyboard Map` key, as written. */
  key: string
  action: number
  text: string
  source: Member
}

/** Reads one `Keyboard Map` member, or explains why it could not be read. */
function readEntry(entry: Member): ReadEntry | string {
  if (entry.value.kind !== 'object') return 'is not an object'
  const action = member(entry.value, 'Action')
  if (
    action === undefined ||
    action.value.kind !== 'scalar' ||
    typeof action.value.value !== 'number'
  ) {
    return 'has no numeric "Action"'
  }
  const text = stringMember(entry.value, 'Text')
  return { key: entry.name, action: action.value.value, text: text?.value ?? '', source: entry }
}

function parse(contents: string): ParseOutcome {
  let root: JsoncNode | null
  try {
    root = readDocument(contents)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `the iTerm2 dynamic profile is not valid JSON: ${message}` }
  }

  if (root !== null && root.kind !== 'object') {
    // iTerm2 rejects the same shape: "does not have an Object (i.e., a
    // dictionary) as its root element".
    return { ok: false, error: 'an iTerm2 dynamic profile must contain an object' }
  }

  const map = keyboardMap(unikeysProfile(root))
  // No unikeys profile, or one with no key map, is a file that overrides
  // nothing rather than a broken one.
  if (map === null) return { ok: true, bindings: [], problems: [] }

  const bindings: ParsedBinding[] = []
  const problems: ParseProblem[] = []
  const seen = new Map<string, string>()

  for (const entry of map.members) {
    const read = readEntry(entry)
    if (typeof read === 'string') {
      problems.push({
        message: `the mapping for "${entry.name}" ${read}`,
        detail: excerpt(contents, entry)
      })
      continue
    }

    const token = TOKEN_BY_ENTRY.get(entryKey(read))
    // An entry unikeys has no token for is the user's own mapping, not a
    // problem. Reporting one per unmodelled entry would flood the panel for
    // anybody who hand-edits this file.
    if (token === undefined) continue

    const first = seen.get(token)
    if (first !== undefined) {
      problems.push({
        message: `"${ITERM2_ACTIONS[token].label}" is mapped twice, at ${first} and ${read.key}; unikeys is using ${first}`,
        detail: excerpt(contents, entry)
      })
      continue
    }

    const chord = decodeChord(read.key)
    if (chord === null) {
      problems.push({
        message: `cannot read the shortcut "${read.key}" for "${ITERM2_ACTIONS[token].label}"`,
        detail: excerpt(contents, entry)
      })
      continue
    }

    seen.set(token, read.key)
    bindings.push({ command: token, chord, source: 'user' })
  }

  // No `defaultsSuppressed`: a profile key map layers over iTerm2's global map
  // and menu bar and never discards them wholesale.
  return { ok: true, bindings, problems }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

interface Layout {
  newline: string
  unit: string
}

function detectLayout(contents: string): Layout {
  return {
    newline: contents.includes('\r\n') ? '\r\n' : '\n',
    unit: /^\t/m.test(contents) ? '\t' : '  '
  }
}

function memberIndent(contents: string, node: ObjectNode, fallback: string): string {
  const first = node.members[0]
  if (first === undefined) return fallback
  const observed = indentOfLineAt(contents, first.start)
  return observed === '' ? fallback : observed
}

function openingIndent(contents: string, node: Span): string {
  const lineStart = contents.lastIndexOf('\n', node.start - 1) + 1
  const before = contents.slice(lineStart, node.start)
  const match = /^[ \t]*/.exec(before)
  return match === null ? '' : match[0]
}

function renderEntry(key: string, entry: { action: number; text: string }): string {
  return `${JSON.stringify(key)}: { "Action": ${entry.action}, "Text": ${JSON.stringify(entry.text)} }`
}

/** Renders a `Keyboard Map` object body, one member per line. */
function renderMap(members: string[], layout: Layout, indent: string): string {
  if (members.length === 0) return '{}'
  const inner = indent + layout.unit
  return `{${layout.newline}${inner}${members.join(`,${layout.newline}${inner}`)}${layout.newline}${indent}}`
}

function renderProfile(members: string[], layout: Layout, indent: string): string {
  const inner = indent + layout.unit
  const body = [
    `"Name": ${JSON.stringify(UNIKEYS_PROFILE_NAME)}`,
    `"Guid": ${JSON.stringify(UNIKEYS_PROFILE_GUID)}`,
    `"Dynamic Profile Parent Name": ${JSON.stringify(PARENT_PROFILE_NAME)}`,
    `"Keyboard Map": ${renderMap(members, layout, inner)}`
  ].join(`,${layout.newline}${inner}`)
  return `{${layout.newline}${inner}${body}${layout.newline}${indent}}`
}

/** One member of the key map unikeys intends to write. */
interface PlannedEntry {
  key: string
  /** `entryKey` of the action, or `raw:<source>` for a member kept verbatim. */
  identity: string
  /** The rendered (or original) source text of the whole member. */
  text: string
}

/** What unikeys wants the key map to say, given the bindings it manages. */
interface Plan {
  /** `key -> entry`, in the order unikeys writes them. */
  entries: Array<[string, { action: number; text: string }]>
  skipped: InexpressibleChord[]
  /**
   * Keys unikeys may take over: the ones it is writing, plus the shipped
   * defaults it is suppressing. Only ever populated from *resolved* commands.
   */
  owned: Set<string>
  /**
   * Commands whose desired state is definite — written, or deliberately
   * unbound. A command that was skipped is **not** here, and a command absent
   * from `managed` never was: in both cases whatever the file already says
   * about it must survive untouched, exactly as the other adapters behave.
   */
  resolved: Set<string>
}

function planEntries(managed: ManagedBinding[], foreignKeys: ReadonlySet<string>): Plan {
  const entries: Array<[string, { action: number; text: string }]> = []
  const skipped: InexpressibleChord[] = []
  const owned = new Set<string>()
  const resolved = new Set<string>()
  const claimedBy = new Map<string, string>()

  // Collected and applied after every binding, so an explicit binding always
  // beats a default-suppression that wants the same key.
  const suppressions: string[] = []

  for (const binding of managed) {
    const entry = ITERM2_ACTIONS[binding.command]
    if (entry === undefined) {
      if (binding.chord !== null) {
        skipped.push({
          command: binding.command,
          chord: binding.chord,
          reason: `"${binding.command}" is not an iTerm2 action unikeys knows`
        })
      }
      continue
    }

    const shipped = defaultEncodedKey(binding.command)

    if (binding.chord === null) {
      // Nothing to bind: any prior entry for this action goes, and the shipped
      // default is suppressed below so "unbound" really is unbound.
      resolved.add(binding.command)
      if (shipped !== null) {
        owned.add(shipped)
        suppressions.push(shipped)
      }
      continue
    }

    const encoded = encodeChord(binding.chord)
    if (!encoded.ok) {
      // Left unresolved on purpose: a skip must leave the file as it was.
      skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
      continue
    }

    const clash = claimedBy.get(encoded.value)
    if (clash !== undefined) {
      // A JSON object cannot hold the same key twice, so this is a real loss and
      // has to reach the user rather than be silently overwritten.
      skipped.push({
        command: binding.command,
        chord: binding.chord,
        reason: `${ITERM2_ACTIONS[clash].label} already uses this shortcut in iTerm2`
      })
      continue
    }

    if (foreignKeys.has(encoded.value)) {
      skipped.push({
        command: binding.command,
        chord: binding.chord,
        reason: 'a mapping added by hand in iTerm2 already uses this shortcut'
      })
      continue
    }

    claimedBy.set(encoded.value, binding.command)
    resolved.add(binding.command)
    owned.add(encoded.value)
    entries.push([encoded.value, { action: entry.action, text: entry.text }])
    if (shipped !== null && shipped !== encoded.value) {
      owned.add(shipped)
      suppressions.push(shipped)
    }
  }

  for (const key of suppressions) {
    // An explicit binding, or a mapping the user added, keeps the key.
    if (claimedBy.has(key) || foreignKeys.has(key)) continue
    claimedBy.set(key, 'ignore')
    entries.push([key, { action: IGNORE_ENTRY.action, text: IGNORE_ENTRY.text }])
  }

  return { entries, skipped, owned, resolved }
}

/** The identity of an existing member: its action, or its source when unreadable. */
function identityOf(base: string, entry: Member): string {
  const read = readEntry(entry)
  return typeof read === 'string' ? `raw:${base.slice(entry.start, entry.end)}` : entryKey(read)
}

function merge(contents: string, managed: ManagedBinding[]): MergeOutcome {
  const base = contents.trim() === '' ? emptyContents() : contents

  let root: JsoncNode | null
  try {
    root = readDocument(base)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: `refusing to write: the iTerm2 dynamic profile is not valid JSON: ${message}`
    }
  }
  if (root === null || root.kind !== 'object') {
    return {
      ok: false,
      error: 'refusing to write: an iTerm2 dynamic profile must contain an object'
    }
  }

  const profiles = member(root, 'Profiles')
  if (profiles === undefined || profiles.value.kind !== 'array') {
    return { ok: false, error: 'refusing to write: the dynamic profile has no "Profiles" array' }
  }

  const layout = detectLayout(base)
  const profile = unikeysProfile(root)
  const map = keyboardMap(profile)

  const existing =
    map === null ? [] : map.members.map((entry) => ({ entry, read: readEntry(entry) }))

  // A mapping the user added by hand: one whose action unikeys has no token for,
  // and which is not an `Ignore`. unikeys never takes such a key, so these are
  // settled before planning rather than after it — a binding that would land on
  // one is skipped outright and its previous entry left alone.
  const foreignKeys = new Set(
    existing
      .filter(
        ({ read }) =>
          typeof read === 'string' ||
          (!TOKEN_BY_ENTRY.has(entryKey(read)) && read.action !== IGNORE_ENTRY.action)
      )
      .map(({ entry }) => entry.name)
  )

  const { entries, skipped, owned, resolved } = planEntries(managed, foreignKeys)

  // Everything unikeys is not resolving this save survives verbatim — source
  // text, not a re-render — so any Version, Label or Escaping member it carries
  // comes through untouched.
  const kept: PlannedEntry[] = []
  for (const { entry, read } of existing) {
    if (typeof read !== 'string') {
      const token = TOKEN_BY_ENTRY.get(entryKey(read))
      const isOurs =
        (token !== undefined && resolved.has(token)) ||
        (read.action === IGNORE_ENTRY.action && owned.has(read.key))
      if (isOurs) continue
    }
    kept.push({
      key: entry.name,
      identity: identityOf(base, entry),
      text: base.slice(entry.start, entry.end)
    })
  }

  const keptKeys = new Set(kept.map((k) => k.key))
  const written = entries
    // `foreignKeys` is already excluded by the plan; this catches a key held by
    // a kept unikeys entry for a command this save is not resolving.
    .filter(([key]) => !keptKeys.has(key))
    .map(([key, entry]) => ({ key, identity: entryKey(entry), text: renderEntry(key, entry) }))

  const final = [...kept, ...written]

  // Nothing to say. Comparing decoded identities rather than source text keeps
  // an already-correct file byte-identical whatever formatting it was written
  // with, which is what makes a no-op save a true no-op.
  if (map !== null && sameMembers(base, map, final)) {
    return { ok: true, contents: base, skipped }
  }

  const rendered = final.map((entry) => entry.text)
  const edits: Edit[] = []
  if (map !== null) {
    edits.push({
      start: map.start,
      end: map.end,
      text: renderMap(rendered, layout, openingIndent(base, map))
    })
  } else if (profile !== null) {
    const indent = memberIndent(base, profile, openingIndent(base, profile) + layout.unit)
    edits.push(
      insertMember(
        profile,
        layout,
        indent,
        `"Keyboard Map": ${renderMap(rendered, layout, indent)}`
      )
    )
  } else {
    const array = profiles.value
    const indent =
      array.items[0] !== undefined
        ? indentOfLineAt(base, array.items[0].start) || openingIndent(base, array) + layout.unit
        : openingIndent(base, array) + layout.unit
    const text = renderProfile(rendered, layout, indent)
    const last = array.items[array.items.length - 1]
    edits.push(
      last === undefined
        ? {
            start: array.end - 1,
            end: array.end - 1,
            text: `${layout.newline}${indent}${text}${layout.newline}${openingIndent(base, array)}`
          }
        : { start: last.end, end: last.end, text: `,${layout.newline}${indent}${text}` }
    )
  }

  return { ok: true, contents: applyEdits(base, edits), skipped }
}

/** True when the key map already holds exactly these members, in this order. */
function sameMembers(base: string, map: ObjectNode, final: PlannedEntry[]): boolean {
  if (map.members.length !== final.length) return false
  return map.members.every((entry, i) => {
    const planned = final[i]
    return entry.name === planned.key && identityOf(base, entry) === planned.identity
  })
}

function insertMember(node: ObjectNode, layout: Layout, indent: string, text: string): Edit {
  const last = node.members[node.members.length - 1]
  if (last === undefined) {
    const closing = node.end - 1
    const closeIndent = indent.slice(0, Math.max(0, indent.length - layout.unit.length))
    return {
      start: closing,
      end: closing,
      text: `${layout.newline}${indent}${text}${layout.newline}${closeIndent}`
    }
  }
  return { start: last.end, end: last.end, text: `,${layout.newline}${indent}${text}` }
}

function emptyContents(): string {
  return [
    '{',
    '  "Profiles": [',
    '    {',
    `      "Name": ${JSON.stringify(UNIKEYS_PROFILE_NAME)},`,
    `      "Guid": ${JSON.stringify(UNIKEYS_PROFILE_GUID)},`,
    `      "Dynamic Profile Parent Name": ${JSON.stringify(PARENT_PROFILE_NAME)},`,
    '      "Keyboard Map": {}',
    '    }',
    '  ]',
    '}',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------

export const iterm2Adapter: Adapter = {
  format: 'iterm2-dynamic-profile',
  apps: ['iterm2'],

  parse,
  merge,
  encodeChord,

  decodeChord(text: string): Chord | null {
    return decodeChord(text)
  },

  defaults(app: AppId): DefaultsReport {
    if (app !== 'iterm2') {
      return {
        availability: 'unavailable',
        note: `The iTerm2 adapter has no defaults for ${app}.`,
        bindings: []
      }
    }
    const bindings: ParsedBinding[] = []
    for (const [command, text] of Object.entries(DEFAULT_CHORDS)) {
      const chord = parseCanonical(text)
      if (chord !== null && chord.strokes.length <= MAX_STROKES) {
        bindings.push({ command, chord, source: 'default' })
      }
    }
    return { availability: 'partial', note: DEFAULTS_NOTE, bindings }
  },

  emptyContents
}
