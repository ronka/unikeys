/**
 * The Warp adapter.
 *
 * Warp keeps custom shortcuts in `~/.warp/keybindings.yaml`: a flat YAML map of
 * action name to key binding, one binding per line. That is close enough to
 * Ghostty's line-based config that this adapter is built the same way — it
 * edits **text**, line by line, and never parses to a model and reserialises.
 * A YAML round-trip would reflow quoting, reorder keys and drop every comment
 * the user wrote, and the byte-identical round-trip this project guarantees
 * rules that out. There is deliberately no YAML dependency here.
 *
 * The consequence is that this adapter understands a **subset of YAML**: a
 * top-level map whose entries fit on one line as `key: value`, with optional
 * quoting on either side, `#` comments, and `---` document markers. Anything
 * else the line scanner cannot account for — a nested map, an anchor or alias,
 * a flow-style or block-scalar value — becomes a `ParseProblem` on that entry
 * and nothing more, so a config with twenty good lines and one anchor shows
 * twenty bindings and one problem.
 *
 * A file in which *no* line is a top-level entry is a different matter: it is
 * not a keybindings map at all, and parsing fails so the column reads
 * `config-unparseable` rather than claiming Warp has nothing bound.
 *
 * Two things Warp's notation does that need care:
 *
 * - **Shift is spelled into the key.** Warp's value is the character the key
 *   produces, so `Command + Shift + K` is `shift-cmd-K`, and `Command + Shift +
 *   ]` is `shift-cmd-}`. Encoding applies the US-layout shifted character;
 *   decoding takes an uppercase letter or a shifted character to imply shift.
 * - **`meta` is not `cmd`.** Warp lists `meta` as a modifier of its own,
 *   separate from `cmd`, and the canonical chord model has no equivalent.
 *   Folding it into `cmd` would silently claim `meta-d` and `cmd-d` are the
 *   same binding, so `meta` is refused with a reason instead — the same call
 *   Ghostty's adapter makes for trigger prefixes it does not model.
 *
 * Warp binds exactly one keystroke per action; it has no leader sequences. A
 * two-keystroke chord is therefore an `InexpressibleChord`, reported to the
 * user rather than truncated or dropped.
 */

import type { AppId } from '../apps'
import {
  CANONICAL_KEYS,
  canonicalKey,
  formatCanonical,
  normalizeModifiers,
  type Chord,
  type KeyStroke,
  type Modifier
} from '../chord'
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
// Warp's key vocabulary
// ---------------------------------------------------------------------------

/** Warp's modifier names on macOS. `meta` is handled separately; see below. */
const WARP_MODIFIERS: Record<string, Modifier> = {
  ctrl: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  cmd: 'cmd'
}

/**
 * Warp's fifth modifier. It is not `cmd` and it is not `alt`, and the canonical
 * model has no fifth slot, so bindings using it are refused by name rather than
 * quietly rewritten as something else.
 */
const META = 'meta'

/**
 * Warp's non-printing key names, from the keysets `FORMAT.md`. Every one of
 * them is spelled exactly as the canonical model spells it, which is why there
 * is no name table in either direction — only the one alias below.
 *
 * `space` is absent on purpose: Warp names no key for the space bar, and a
 * hyphen-joined value cannot carry a literal space, so it is refused in both
 * directions rather than guessed at in one.
 */
const WARP_NON_PRINTING: ReadonlySet<string> = new Set([
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'backspace',
  'enter',
  'insert',
  'delete',
  'escape',
  'tab',
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`)
])

/** The one Warp spelling the canonical model does not already accept. */
const WARP_KEY_ALIASES: Record<string, string> = { numpadenter: 'enter' }

/**
 * The character each key produces with Shift held, on the US layout Warp's own
 * default keyset is written against (`shift-cmd-}` is Shift and `]`). Letters
 * are handled by case and are not listed.
 */
const SHIFTED_CHARACTERS: Record<string, string> = {
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
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

const UNSHIFTED_CHARACTERS: Record<string, string> = Object.fromEntries(
  Object.entries(SHIFTED_CHARACTERS).map(([base, shifted]) => [shifted, base])
)

const MANAGED_MARKER = '# Managed by unikeys'

/** YAML spellings of null. An entry carrying one of these unbinds its action. */
const NULL_TOKENS: ReadonlySet<string> = new Set(['~', 'null', 'Null', 'NULL'])

/**
 * Characters that open a YAML construct this line scanner does not model —
 * anchors, aliases, tags, flow collections, block scalars, directives. A value
 * starting with one is reported rather than read as a key binding.
 */
const UNMODELLED_VALUE_STARTS: Record<string, string> = {
  '&': 'an anchor',
  '*': 'an alias',
  '!': 'a tag',
  '{': 'a flow mapping',
  '[': 'a flow sequence',
  '|': 'a block scalar',
  '>': 'a folded scalar',
  '%': 'a directive',
  '@': 'a reserved indicator',
  '`': 'a reserved indicator'
}

// ---------------------------------------------------------------------------
// Chord translation
// ---------------------------------------------------------------------------

type DecodeResult = { ok: true; chord: Chord } | { ok: false; reason: string }

function decodeBinding(text: string): DecodeResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, reason: 'binding is empty' }

  const tokens = tokenize(trimmed)
  // The format is a hyphen-separated list of modifiers ending with the key, so
  // the last token is always the key and everything before it is a modifier.
  const keyToken = tokens[tokens.length - 1]
  const modifierTokens = tokens.slice(0, -1)

  const modifiers: Modifier[] = []
  for (const token of modifierTokens) {
    const lower = token.toLowerCase()
    if (lower === META) {
      return { ok: false, reason: 'Warp’s `meta` modifier has no canonical equivalent' }
    }
    const modifier = WARP_MODIFIERS[lower]
    if (!modifier) return { ok: false, reason: `unknown modifier \`${token}\`` }
    modifiers.push(modifier)
  }

  const decoded = decodeKey(keyToken)
  if (!decoded) return { ok: false, reason: `unrecognised key \`${keyToken}\`` }
  if (decoded.shifted) modifiers.push('shift')

  return {
    ok: true,
    chord: { strokes: [{ modifiers: normalizeModifiers(modifiers), key: decoded.key }] }
  }
}

/**
 * Resolves the key half of a binding. `shifted` reports that the *character*
 * itself carries Shift — `K` and `}` do, `k` and `]` do not — which is how Warp
 * spells a shifted printable key whether or not `shift-` is also written out.
 */
function decodeKey(token: string): { key: string; shifted: boolean } | null {
  const lower = token.toLowerCase()

  const aliased = WARP_KEY_ALIASES[lower]
  if (aliased) return { key: aliased, shifted: false }

  if (token.length === 1) {
    if (token >= 'A' && token <= 'Z') return { key: lower, shifted: true }
    const unshifted = UNSHIFTED_CHARACTERS[token]
    if (unshifted) return { key: unshifted, shifted: true }
    const key = canonicalKey(token)
    return key === null ? null : { key, shifted: false }
  }

  if (!WARP_NON_PRINTING.has(lower)) return null
  const key = canonicalKey(lower)
  return key === null ? null : { key, shifted: false }
}

/**
 * Splits `alt-cmd-left` into tokens. A `-` immediately after a separator is the
 * key itself, which is what keeps `cmd--` — Warp's own decrease-font-size
 * default — readable.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  for (const char of text) {
    if (char === '-' && current !== '') {
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
  if (!CANONICAL_KEYS.has(key)) return { ok: false, reason: `Warp has no key named \`${s.key}\`` }
  if (key === 'space') {
    return { ok: false, reason: 'Warp has no name for the space bar, so it cannot be bound here' }
  }

  const modifiers = normalizeModifiers(s.modifiers)

  let keyText: string
  if (WARP_NON_PRINTING.has(key)) {
    keyText = key
  } else if (modifiers.includes('shift')) {
    // Warp's value is the character the key produces, so Shift is spelled into
    // the key as well as listed as a modifier: `shift-cmd-K`, not `shift-cmd-k`.
    keyText = SHIFTED_CHARACTERS[key] ?? key.toUpperCase()
  } else {
    keyText = key
  }

  return { ok: true, value: [...modifiers, keyText].join('-') }
}

function encodeBinding(c: Chord): EncodeOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'chord has no keystrokes' }
  if (c.strokes.length > 1) {
    return {
      ok: false,
      reason:
        `Warp binds one keystroke per action and has no sequences, so ` +
        `\`${formatCanonical(c)}\` cannot be written`
    }
  }
  return encodeStroke(c.strokes[0])
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

/**
 * One `key: value` entry, sliced so every byte of the original line can be put
 * back. `keyText` and `valueText` keep their quotes, because a rewrite that
 * unquoted a quoted value would change bytes the user did not ask us to change.
 */
interface EntryLine {
  indent: string
  keyText: string
  /** The action name with quotes removed. */
  key: string
  /** The colon and the spacing around it. */
  separator: string
  valueText: string
  /** Trailing spacing and any `#` comment, kept verbatim. */
  suffix: string
}

/**
 * Recognises a one-line top-level `key: value` entry, or returns `null` for a
 * line that is something else. Quoted and bare keys are both accepted; a bare
 * key ends at the first colon followed by whitespace or end of line, which is
 * what keeps Warp's own colon-bearing action names (`workspace:new_tab`) whole.
 */
function readEntryLine(text: string): EntryLine | null {
  const indent = text.slice(0, text.length - text.trimStart().length)
  const rest = text.slice(indent.length)
  if (rest === '') return null

  // Sequence items and flow collections are not map entries, whatever colons
  // they happen to contain.
  if (rest === '-' || rest.startsWith('- ') || rest.startsWith('-\t')) return null
  if (rest.startsWith('[') || rest.startsWith('{') || rest.startsWith('#')) return null

  const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : null
  let keyText: string
  let key: string
  let afterKey: number

  if (quote) {
    const close = findClosingQuote(rest, quote)
    if (close === -1) return null
    keyText = rest.slice(0, close + 1)
    key = unquote(keyText)
    afterKey = close + 1
  } else {
    const colon = findKeyColon(rest)
    if (colon <= 0) return null
    keyText = rest.slice(0, colon).trimEnd()
    key = keyText
    afterKey = keyText.length
  }
  if (key === '') return null

  const separatorMatch = rest.slice(afterKey).match(/^[ \t]*:[ \t]*/)
  if (!separatorMatch) return null
  const separator = separatorMatch[0]

  const valuePart = rest.slice(afterKey + separator.length)
  const { valueText, suffix } = splitValueAndSuffix(valuePart)

  return { indent, keyText, key, separator, valueText, suffix }
}

/** The first colon that ends a bare key: one followed by whitespace or nothing. */
function findKeyColon(rest: string): number {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== ':') continue
    const next = rest[i + 1]
    if (next === undefined || next === ' ' || next === '\t') return i
  }
  return -1
}

function findClosingQuote(rest: string, quote: string): number {
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '\\' && quote === '"') {
      i++
      continue
    }
    if (rest[i] === quote) return i
  }
  return -1
}

function unquote(text: string): string {
  const quote = text[0]
  if ((quote !== '"' && quote !== "'") || text.length < 2 || text[text.length - 1] !== quote) {
    return text
  }
  const inner = text.slice(1, -1)
  return quote === '"' ? inner.replace(/\\(.)/g, '$1') : inner.replace(/''/g, "'")
}

/**
 * Separates the value from the trailing spacing and comment. A `#` only starts
 * a comment when whitespace precedes it, so `cmd-#` stays a binding.
 */
function splitValueAndSuffix(valuePart: string): { valueText: string; suffix: string } {
  let end = valuePart.length
  for (let i = 0; i < valuePart.length; i++) {
    if (valuePart[i] !== '#') continue
    const previous = valuePart[i - 1]
    if (i === 0 || previous === ' ' || previous === '\t') {
      end = i
      break
    }
  }
  const head = valuePart.slice(0, end)
  const valueText = head.trimEnd()
  return { valueText, suffix: head.slice(valueText.length) + valuePart.slice(end) }
}

function renderEntry(entry: EntryLine, valueText: string): string {
  if (valueText === '') {
    // An entry that names no binding: `"terminal:copy":`, with nothing after
    // the colon to leave a stray trailing space behind.
    return `${entry.indent}${entry.keyText}${entry.separator.trimEnd()}${entry.suffix}`
  }
  const separator = /[ \t]$/.test(entry.separator) ? entry.separator : `${entry.separator} `
  return `${entry.indent}${entry.keyText}${separator}${valueText}${entry.suffix}`
}

/** True when a bare scalar would be read back as something other than itself. */
function needsQuoting(value: string): boolean {
  return value === '' || NULL_TOKENS.has(value) || value[0] in UNMODELLED_VALUE_STARTS
}

// ---------------------------------------------------------------------------
// Line scanning
// ---------------------------------------------------------------------------

type LineKind = 'blank' | 'comment' | 'document' | 'entry' | 'unreadable'

interface ScannedLine extends SourceLine {
  kind: LineKind
  entry: EntryLine | null
}

function scan(contents: string): ScannedLine[] {
  return splitLines(contents).map((line): ScannedLine => {
    const trimmed = line.text.trim()
    if (trimmed === '') return { ...line, kind: 'blank', entry: null }
    if (trimmed.startsWith('#')) return { ...line, kind: 'comment', entry: null }
    if (trimmed === '---' || trimmed === '...') return { ...line, kind: 'document', entry: null }
    const entry = readEntryLine(line.text)
    if (entry) return { ...line, kind: 'entry', entry }
    return { ...line, kind: 'unreadable', entry: null }
  })
}

/** True when this entry is the head of a nested map rather than a binding. */
function opensNestedMap(lines: ScannedLine[], index: number): boolean {
  const entry = lines[index].entry
  if (!entry || entry.valueText !== '') return false
  for (let i = index + 1; i < lines.length; i++) {
    const next = lines[i]
    if (next.kind === 'blank' || next.kind === 'comment') continue
    const nextIndent = next.text.slice(0, next.text.length - next.text.trimStart().length)
    return nextIndent.length > entry.indent.length
  }
  return false
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * Warp's default keyset, transcribed from `default-warp-keybindings.yaml` in
 * the `warpdotdev/keysets` repository. Unlike most tables in this project these
 * values are Warp's own rather than someone's reading of the documentation —
 * but the file is not a complete account of Warp's defaults, so `defaults()`
 * still reports `partial`. See `DEFAULTS_NOTE`.
 *
 * `workspace:new_tab` is the one entry added by hand: the published keyset
 * omits it, while Warp's own keyboard-shortcuts documentation lists it at
 * `CMD-T`, and it is the action the New Terminal row maps.
 */
const DEFAULT_BINDINGS: Record<string, string> = {
  'editor:delete_word_left': 'alt-backspace',
  'editor:delete_word_right': 'alt-delete',
  'editor:insert_last_word_previous_command': 'meta-.',
  'editor:select_to_line_end': 'ctrl-shift-E',
  'editor:select_to_line_start': 'ctrl-shift-A',
  'editor_view:add_cursor_above': 'ctrl-shift-up',
  'editor_view:add_cursor_below': 'ctrl-shift-down',
  'editor_view:add_next_occurrence': 'ctrl-g',
  'editor_view:backspace': 'ctrl-h',
  'editor_view:clear_and_copy_lines': 'ctrl-u',
  'editor_view:clear_buffer': 'ctrl-c',
  'editor_view:clear_lines': 'shift-cmd-K',
  'editor_view:cmd_down': 'cmd-down',
  'editor_view:cmd_i': 'cmd-i',
  'editor_view:cut_all_right': 'ctrl-k',
  'editor_view:cut_word_left': 'ctrl-w',
  'editor_view:cut_word_right': 'meta-d',
  'editor_view:delete': 'ctrl-d',
  'editor_view:delete_all_left': 'cmd-backspace',
  'editor_view:delete_all_right': 'cmd-delete',
  'editor_view:down': 'ctrl-n',
  'editor_view:end': 'cmd-right',
  'editor_view:fold': 'alt-cmd-[',
  'editor_view:fold_selected_ranges': 'alt-cmd-f',
  'editor_view:home': 'cmd-left',
  'editor_view:insert_newline': 'ctrl-j',
  'editor_view:left': 'ctrl-b',
  'editor_view:move_backward_one_word': 'meta-b',
  'editor_view:move_forward_one_word': 'meta-f',
  'editor_view:move_to_buffer_end': 'shift-meta->',
  'editor_view:move_to_buffer_start': 'shift-meta-<',
  'editor_view:move_to_line_end': 'ctrl-e',
  'editor_view:move_to_line_start': 'ctrl-a',
  'editor_view:move_to_paragraph_end': 'meta-e',
  'editor_view:move_to_paragraph_start': 'meta-a',
  'editor_view:right': 'ctrl-f',
  'editor_view:select_all': 'cmd-a',
  'editor_view:select_down': 'ctrl-shift-N',
  'editor_view:select_left': 'ctrl-shift-B',
  'editor_view:select_left_by_word': 'shift-meta-B',
  'editor_view:select_right': 'ctrl-shift-F',
  'editor_view:select_right_by_word': 'shift-meta-F',
  'editor_view:select_up': 'ctrl-shift-P',
  'editor_view:unfold': 'alt-cmd-]',
  'editor_view:up': 'ctrl-p',
  'find:find_next_occurrence': 'cmd-g',
  'find:find_prev_occurrence': 'shift-cmd-G',
  'input:clear_screen': 'ctrl-l',
  'input:toggle_natural_language_command_search': 'ctrl-`',
  'input:toggle_workflows': 'ctrl-shift-R',
  'pane_group:add_down': 'shift-cmd-D',
  'pane_group:add_right': 'cmd-d',
  'pane_group:navigate_down': 'alt-cmd-down',
  'pane_group:navigate_left': 'alt-cmd-left',
  'pane_group:navigate_next': 'cmd-]',
  'pane_group:navigate_prev': 'cmd-[',
  'pane_group:navigate_right': 'alt-cmd-right',
  'pane_group:navigate_up': 'alt-cmd-up',
  'pane_group:resize_down': 'ctrl-cmd-down',
  'pane_group:resize_left': 'ctrl-cmd-left',
  'pane_group:resize_right': 'ctrl-cmd-right',
  'pane_group:resize_up': 'ctrl-cmd-up',
  'pane_group:toggle_maximize_pane': 'shift-cmd-enter',
  'terminal:bookmark_selected_block': 'cmd-b',
  'terminal:copy': 'cmd-c',
  'terminal:copy_commands': 'shift-cmd-C',
  'terminal:copy_outputs': 'alt-shift-cmd-C',
  'terminal:expand_block_selection_above': 'shift-up',
  'terminal:expand_block_selection_below': 'shift-down',
  'terminal:find': 'cmd-f',
  'terminal:focus_input': 'cmd-l',
  'terminal:open_block_list_context_menu_via_keybinding': 'ctrl-m',
  'terminal:open_share_modal': 'shift-cmd-S',
  'terminal:paste': 'cmd-v',
  'terminal:reinput_commands': 'cmd-i',
  'terminal:reinput_commands_with_sudo': 'shift-cmd-I',
  'terminal:select_all_blocks': 'cmd-a',
  'terminal:select_bookmark_down': 'alt-down',
  'terminal:select_bookmark_up': 'alt-up',
  'terminal:select_next_block': 'cmd-down',
  'terminal:select_previous_block': 'cmd-up',
  'workspace:activate_eighth_tab': 'cmd-8',
  'workspace:activate_fifth_tab': 'cmd-5',
  'workspace:activate_first_tab': 'cmd-1',
  'workspace:activate_fourth_tab': 'cmd-4',
  'workspace:activate_last_tab': 'cmd-9',
  'workspace:activate_next_tab': 'shift-cmd-}',
  'workspace:activate_prev_tab': 'shift-cmd-{',
  'workspace:activate_second_tab': 'cmd-2',
  'workspace:activate_seventh_tab': 'cmd-7',
  'workspace:activate_sixth_tab': 'cmd-6',
  'workspace:activate_third_tab': 'cmd-3',
  'workspace:decrease_font_size': 'cmd--',
  'workspace:increase_font_size': 'cmd-=',
  'workspace:move_tab_left': 'ctrl-shift-left',
  'workspace:move_tab_right': 'ctrl-shift-right',
  'workspace:new_tab': 'cmd-t',
  'workspace:reset_font_size': 'cmd-0',
  'workspace:set_a11y_concise_verbosity_level': 'alt-cmd-v',
  'workspace:set_a11y_verbose_verbosity_level': 'alt-cmd-v',
  'workspace:show_command_search': 'ctrl-r',
  'workspace:show_keybinding_settings': 'ctrl-cmd-k',
  'workspace:show_settings_account_page': 'cmd-,',
  'workspace:show_settings_modal': 'cmd-,',
  'workspace:show_theme_chooser': 'ctrl-cmd-t',
  'workspace:toggle_command_palette': 'cmd-p',
  'workspace:toggle_launch_config_palette': 'ctrl-cmd-l',
  'workspace:toggle_mouse_reporting': 'cmd-r',
  'workspace:toggle_navigation_palette': 'shift-cmd-P',
  'workspace:toggle_resource_center': 'ctrl-shift-?'
}

const DEFAULTS_NOTE =
  'Warp defaults are transcribed from Warp’s published default keyset ' +
  '(warpdotdev/keysets) rather than read from the installed app. That file lags ' +
  'Warp’s documented shortcuts, and the entries using Warp’s `meta` modifier have ' +
  'no canonical equivalent and are omitted, so the list is incomplete.'

/**
 * Every Warp action name this adapter knows. Exported so the catalogue can be
 * checked against it: a mapping naming an action Warp does not have would write
 * a binding that never fires.
 */
export const WARP_ACTION_IDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_BINDINGS))

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedContents {
  bindings: ParsedBinding[]
  problems: ParseProblem[]
  /** Top-level `key: value` lines, however readable their value turned out. */
  entryCount: number
  unreadableCount: number
}

function parseContents(contents: string): ParsedContents {
  const bindings: ParsedBinding[] = []
  const problems: ParseProblem[] = []
  const lines = scan(contents)
  let entryCount = 0
  let unreadableCount = 0

  lines.forEach((line, index) => {
    if (line.kind === 'blank' || line.kind === 'comment' || line.kind === 'document') return

    if (line.kind === 'unreadable') {
      unreadableCount++
      problems.push({ message: 'Line is not a `key: value` entry', detail: line.text.trim() })
      return
    }

    const entry = line.entry!
    const detail = line.text.trim()

    if (entry.indent !== '') {
      // A child of some nested map. The parent was already reported; this line
      // is reported too so nothing about it is silently swallowed.
      problems.push({ message: 'Nested entries are not supported', detail })
      return
    }

    entryCount++

    if (opensNestedMap(lines, index)) {
      problems.push({
        message: 'Nested maps are not supported; only one-line `action: binding` entries are read',
        detail
      })
      return
    }

    const bare = entry.valueText
    if (bare !== '' && bare[0] in UNMODELLED_VALUE_STARTS) {
      problems.push({
        message: `Value is ${UNMODELLED_VALUE_STARTS[bare[0]]}, which unikeys does not read`,
        detail
      })
      return
    }

    const value = unquote(bare)
    const quoted = bare !== value || (bare.length > 1 && (bare[0] === '"' || bare[0] === "'"))

    if (value === '' || (!quoted && NULL_TOKENS.has(value))) {
      // Warp treats an empty or null value as "this action has no binding",
      // which is a deliberate unbind rather than an entry we never saw.
      bindings.push({ command: entry.key, chord: null, source: 'user', negated: true })
      return
    }

    const decoded = decodeBinding(value)
    if (!decoded.ok) {
      problems.push({ message: `Unreadable keybinding: ${decoded.reason}`, detail })
      return
    }

    bindings.push({ command: entry.key, chord: decoded.chord, source: 'user' })
  })

  return { bindings, problems, entryCount, unreadableCount }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

interface WorkingLine extends ScannedLine {
  removed: boolean
}

function mergeContents(contents: string, managed: ManagedBinding[]): MergeOutcome {
  const source = scan(contents)
  const endedWithNewline = source.length > 0 && source[source.length - 1].eol !== ''
  const lines: WorkingLine[] = source.map((l) => ({ ...l, removed: false }))

  const topLevel = (): WorkingLine[] =>
    lines.filter((l) => !l.removed && l.entry !== null && l.entry.indent === '')

  const dominantEol = pickDominant(source.map((l) => l.eol).filter((e) => e !== '')) ?? '\n'
  // Warp's own keyset quotes every action name, so that is what a file with
  // nothing to copy from gets.
  const quoteKeys =
    pickDominant(topLevel().map((l) => (l.entry!.keyText.startsWith('"') ? 'yes' : 'no'))) !== 'no'
  const dominantSeparator = pickDominant(topLevel().map((l) => l.entry!.separator)) ?? ': '

  const skipped: InexpressibleChord[] = []
  const appended: string[] = []

  for (const binding of managed) {
    const matching = topLevel().filter((l) => l.entry!.key === binding.command)

    if (binding.chord === null) {
      if (DEFAULT_BINDINGS[binding.command] === undefined) {
        // Nothing would come back if the line simply went away.
        for (const line of matching) line.removed = true
        continue
      }
      // Warp ships a default for this action, so the line has to stay and say
      // so: an entry with no value is how Warp spells "not bound".
      const [first, ...extras] = matching
      for (const line of extras) line.removed = true
      if (!first) {
        appended.push(renderAppended(binding.command, '', quoteKeys, dominantSeparator))
        continue
      }
      if (first.entry!.valueText !== '') {
        first.text = renderEntry(first.entry!, '')
        first.entry = readEntryLine(first.text)
      }
      continue
    }

    const encoded = encodeBinding(binding.chord)
    if (!encoded.ok) {
      skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
      continue
    }

    if (matching.length === 0) {
      appended.push(renderAppended(binding.command, encoded.value, quoteKeys, dominantSeparator))
      continue
    }

    // Rewrite the first entry and drop the rest: a duplicate key is the last
    // one winning in YAML, so leaving extras would mean the user's change only
    // half took effect.
    const [first, ...extras] = matching
    for (const line of extras) line.removed = true

    // A line that already says what we were going to say is left exactly as the
    // user wrote it, quoting and spacing included.
    if (!sameBinding(unquote(first.entry!.valueText), encoded.value)) {
      const valueText = requoteLike(first.entry!.valueText, encoded.value)
      first.text = renderEntry(first.entry!, valueText)
      first.entry = readEntryLine(first.text)
    }
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

function renderAppended(
  command: string,
  value: string,
  quoteKeys: boolean,
  separator: string
): string {
  const keyText = quoteKeys ? `"${command}"` : command
  if (value === '') return `${keyText}${separator.trimEnd()}`
  const valueText = needsQuoting(value) ? `"${value}"` : value
  const sep = /[ \t]$/.test(separator) ? separator : `${separator} `
  return `${keyText}${sep}${valueText}`
}

/** Keeps the quoting the user chose for a value we are rewriting. */
function requoteLike(previous: string, value: string): string {
  const quote = previous[0] === '"' || previous[0] === "'" ? previous[0] : null
  if (quote === "'") return `'${value.replace(/'/g, "''")}'`
  if (quote === '"' || needsQuoting(value)) return `"${value.replace(/(["\\])/g, '\\$1')}"`
  return value
}

/** True when two Warp bindings name the same keystroke, however spelled. */
function sameBinding(a: string, b: string): boolean {
  const da = decodeBinding(a)
  const db = decodeBinding(b)
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
 * Puts new entries under a clearly-marked section so a user reading their
 * keybindings file can tell at a glance which lines unikeys owns.
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
    if (readEntryLine(lines[i].text) === null) break
    insertAt = i + 1
  }
  return [...lines.slice(0, insertAt), ...additions, ...lines.slice(insertAt)]
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const warpAdapter: Adapter = {
  format: 'warp-keybindings',
  apps: ['warp'],

  parse(contents: string): ParseOutcome {
    const { bindings, problems, entryCount, unreadableCount } = parseContents(contents)
    if (entryCount === 0 && unreadableCount > 0) {
      // Not one line of the file is a top-level entry: this is not a
      // keybindings map, and saying "no bindings" would be a lie about a file
      // we simply cannot read.
      return { ok: false, error: 'Not a Warp keybindings map of `action: binding` entries.' }
    }
    return { ok: true, bindings, problems }
  },

  merge(contents: string, managed: ManagedBinding[]): MergeOutcome {
    return mergeContents(contents, managed)
  },

  encodeChord(chord: Chord): EncodeOutcome {
    return encodeBinding(chord)
  },

  decodeChord(text: string): Chord | null {
    const decoded = decodeBinding(text)
    return decoded.ok ? decoded.chord : null
  },

  defaults(app: AppId): DefaultsReport {
    if (app !== 'warp') {
      return {
        availability: 'unavailable',
        note: `The Warp adapter has no defaults for ${app}.`,
        bindings: []
      }
    }
    const bindings: ParsedBinding[] = []
    for (const [command, value] of Object.entries(DEFAULT_BINDINGS)) {
      const decoded = decodeBinding(value)
      if (decoded.ok) bindings.push({ command, chord: decoded.chord, source: 'default' })
    }
    return { availability: 'partial', note: DEFAULTS_NOTE, bindings }
  },

  emptyContents(): string {
    return '---\n# Warp keybindings\n'
  }
}
