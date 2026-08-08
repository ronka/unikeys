/**
 * What iTerm2 3.6.11 *is*, as captured from the running application.
 *
 * Split from `iterm2.ts` because it is reviewed differently from the logic
 * beside it. None of this was authored from documentation: the action integers
 * come from `sources/iTermKeyBindingAction.h`, cross-checked against all 14
 * bindings shipped in the app bundle's `DefaultGlobalKeyMap.plist` and
 * `PresetKeyMappings.plist`; the key encoding and the menu-item parameter shape
 * were settled by driving the running app; the menu titles and identifiers by
 * walking its menu bar. Three of those answers contradicted the documentation —
 * see `__fixtures__/iterm2/README.md`.
 *
 * So every value here is pinned to a version, and re-capturing against a later
 * iTerm2 is a matter of re-reading this file rather than picking constants out
 * of the parsing and merging code.
 */

// ---------------------------------------------------------------------------
// The profile unikeys owns
// ---------------------------------------------------------------------------

/**
 * Fixed, never generated at runtime. A fresh Guid per write would make iTerm2
 * treat each save as a different profile, orphaning the previous one and losing
 * whichever one the user had selected.
 */
export const UNIKEYS_PROFILE_GUID = '7B8E4F2A-3C6D-4E19-9A05-1D2F8C4B6E30'
export const UNIKEYS_PROFILE_NAME = 'unikeys'
export const PARENT_PROFILE_NAME = 'Default'

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

/** The value half of a `Keyboard Map` member: what iTerm2 does, and with what. */
export interface EntryValue {
  action: number
  /**
   * iTerm2's parameter. Empty for actions that take none; a profile Guid for the
   * `*_WITH_PROFILE` actions (there is no "current profile" sentinel — an
   * unknown Guid renders as "with unavailable Profile", so unikeys passes its
   * own, which also makes new tabs and splits inherit these bindings); and
   * `"<title>\n<identifier>"` for `SELECT_MENU_ITEM`.
   */
  text: string
}

export interface ItermEntry extends EntryValue {
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
export const ITERM2_ACTIONS: Record<string, ItermEntry> = {
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
export function entryKey(entry: EntryValue): string {
  return `${entry.action}\u0000${entry.text}`
}

export const TOKEN_BY_ENTRY: ReadonlyMap<string, string> = new Map(
  Object.entries(ITERM2_ACTIONS).map(([token, entry]) => [entryKey(entry), token])
)

// ---------------------------------------------------------------------------
// Key encoding
// ---------------------------------------------------------------------------

export const FLAG_SHIFT = 0x20000
export const FLAG_CONTROL = 0x40000
export const FLAG_OPTION = 0x80000
export const FLAG_COMMAND = 0x100000
/** Arrow keys carry this; nothing else unikeys emits does. */
export const FLAG_NUMERIC_PAD = 0x200000

export const KNOWN_FLAGS = FLAG_SHIFT | FLAG_CONTROL | FLAG_OPTION | FLAG_COMMAND | FLAG_NUMERIC_PAD

export interface ItermKey {
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

export const ITERM2_KEYS: Record<string, ItermKey> = (() => {
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

export const KEY_BY_CHAR: ReadonlyMap<number, string> = new Map(
  Object.entries(ITERM2_KEYS).map(([name, key]) => [key.char, name])
)
export const KEY_BY_SHIFTED_CHAR: ReadonlyMap<number, string> = new Map(
  Object.entries(ITERM2_KEYS)
    .filter(([, key]) => key.shifted !== undefined)
    .map(([name, key]) => [key.shifted as number, name])
)

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
export const DEFAULT_CHORDS: Record<string, string> = {
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

export const DEFAULTS_NOTE =
  'iTerm2 ships an empty profile key map, so these defaults are captured from iTerm2 3.6.11’s ' +
  'global key map and menu bar — two surfaces unikeys does not write. Toggle Full Screen and the ' +
  'directional pane-focus actions are not captured. Changing a cell suppresses the one default ' +
  'chord recorded here, so an action iTerm2 also binds elsewhere may still answer its other key.'

/**
 * Suppressing a shipped default: iTerm2's own `{Action: 13}` (Ignore), which is
 * how unikeys stops ⌘D still splitting after the user has moved Split Right to
 * something else. Without it a profile key map only ever *adds* bindings, and a
 * changed cell would leave the original key working too — the same gap Ghostty's
 * `unbind` and VSCode's `-command` entries exist to close.
 */
export const IGNORE: EntryValue = { action: 13, text: '' }
