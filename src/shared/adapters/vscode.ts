/**
 * The VSCode / Cursor adapter.
 *
 * `keybindings.json` is JSONC — a JSON array carrying `//` and block comments
 * and tolerating trailing commas — and it is a file the user hand-edits. That
 * shapes every decision here:
 *
 * - Parsing is done by a small tolerant reader rather than by stripping
 *   comments with a regex, because `//` and `,` occur inside string literals
 *   (`"key": "cmd+/"`, `"when": "a && b, c"`) and a stripper would corrupt them.
 * - Merging is **textual**. The reader records the source span of every value,
 *   so setting a chord splices a new string literal over the old one and leaves
 *   the rest of the file — comments, ordering, blank lines, indentation — byte
 *   for byte as the user left it. Reserialising the parse tree would be far
 *   simpler and would silently reformat a file the user owns.
 * - "Unbound" is a negation entry, never a deletion: deleting a user's entry
 *   restores VSCode's compiled-in default, which is the opposite of unbound.
 */

import type { Chord, KeyStroke, Modifier } from '../chord'
import { MAX_STROKES, canonicalKey, canonicalModifier, normalizeModifiers } from '../chord'
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
// Chord translation
// ---------------------------------------------------------------------------

/**
 * VSCode's parser accepts modifiers in any order, so the order here is chosen
 * for what the user will read in their own file: the spelling used throughout
 * VSCode's documentation and by nearly every config on the internet, which
 * leads with `cmd` (`cmd+shift+p`, `cmd+alt+s`) rather than VSCode's internal
 * `shift+cmd+p` normalisation.
 */
const ENCODE_MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'cmd', 'alt', 'shift']

/**
 * Canonical keys VSCode has no spelling for. Everything else in the canonical
 * vocabulary — letters, digits, punctuation, the named keys, f1–f19 — is
 * written literally, which is why there is no encoding table.
 */
const UNSUPPORTED_KEYS = new Set(['f20'])

function encodeStroke(s: KeyStroke): EncodeOutcome {
  const key = canonicalKey(s.key)
  if (key === null) return { ok: false, reason: `unknown key "${s.key}"` }
  if (UNSUPPORTED_KEYS.has(key)) return { ok: false, reason: `VSCode has no ${key} key` }

  const present = new Set(normalizeModifiers(s.modifiers))
  const parts = ENCODE_MODIFIER_ORDER.filter((m) => present.has(m))
  return { ok: true, value: [...parts, key].join('+') }
}

function encodeChord(c: Chord): EncodeOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'chord has no keystrokes' }
  if (c.strokes.length > MAX_STROKES) {
    return { ok: false, reason: `VSCode supports at most ${MAX_STROKES} keystrokes` }
  }

  const parts: string[] = []
  for (const s of c.strokes) {
    const encoded = encodeStroke(s)
    if (!encoded.ok) return encoded
    parts.push(encoded.value)
  }
  return { ok: true, value: parts.join(' ') }
}

function decodeChord(text: string): Chord | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  const strokeTexts = trimmed.split(/\s+/)
  if (strokeTexts.length > MAX_STROKES) return null

  const strokes: KeyStroke[] = []
  for (const strokeText of strokeTexts) {
    const s = decodeStroke(strokeText)
    if (s === null) return null
    strokes.push(s)
  }
  return { strokes }
}

function decodeStroke(text: string): KeyStroke | null {
  const tokens = tokenizeStroke(text)
  if (tokens.length === 0) return null

  const modifiers: Modifier[] = []
  let key: string | null = null

  for (const token of tokens) {
    const mod = canonicalModifier(token)
    if (mod !== null) {
      // A modifier after the base key is malformed rather than tolerable —
      // guessing at `s+cmd` risks writing a binding the user never asked for.
      if (key !== null) return null
      modifiers.push(mod)
      continue
    }
    if (key !== null) return null
    key = canonicalKey(token)
    if (key === null) return null
  }

  if (key === null) return null
  return { modifiers: normalizeModifiers(modifiers), key }
}

/**
 * Splits `cmd+shift+p` into tokens. `+` separates only when something precedes
 * it, so `cmd+-` and `cmd++` keep their punctuation base key. `-` is never a
 * separator in VSCode notation, unlike unikeys' own tolerant text entry.
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

// ---------------------------------------------------------------------------
// A tolerant JSONC reader
// ---------------------------------------------------------------------------

interface Span {
  start: number
  /** Exclusive, as with `String.prototype.slice`. */
  end: number
}

interface StringNode extends Span {
  kind: 'string'
  value: string
}
interface ScalarNode extends Span {
  kind: 'scalar'
  value: number | boolean | null
}
interface ArrayNode extends Span {
  kind: 'array'
  items: JsoncNode[]
}
interface ObjectNode extends Span {
  kind: 'object'
  members: Member[]
}
interface Member extends Span {
  name: string
  value: JsoncNode
}

type JsoncNode = StringNode | ScalarNode | ArrayNode | ObjectNode

class JsoncError extends Error {}

interface Cursor {
  text: string
  pos: number
}

function skipTrivia(c: Cursor): void {
  for (;;) {
    const char = c.text[c.pos]
    if (char === undefined) return
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      c.pos++
      continue
    }
    if (char === '/' && c.text[c.pos + 1] === '/') {
      while (c.pos < c.text.length && c.text[c.pos] !== '\n') c.pos++
      continue
    }
    if (char === '/' && c.text[c.pos + 1] === '*') {
      const close = c.text.indexOf('*/', c.pos + 2)
      if (close === -1) throw new JsoncError(`unterminated block comment at position ${c.pos}`)
      c.pos = close + 2
      continue
    }
    return
  }
}

function expect(c: Cursor, char: string): void {
  if (c.text[c.pos] !== char) {
    const found = c.text[c.pos] === undefined ? 'end of file' : `"${c.text[c.pos]}"`
    throw new JsoncError(`expected "${char}" at position ${c.pos} but found ${found}`)
  }
  c.pos++
}

const STRING_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t'
}

function readString(c: Cursor): StringNode {
  const start = c.pos
  expect(c, '"')
  let value = ''
  for (;;) {
    const char = c.text[c.pos]
    if (char === undefined || char === '\n') {
      throw new JsoncError(`unterminated string starting at position ${start}`)
    }
    if (char === '"') {
      c.pos++
      return { kind: 'string', start, end: c.pos, value }
    }
    if (char === '\\') {
      const escape = c.text[c.pos + 1]
      if (escape === 'u') {
        const hex = c.text.slice(c.pos + 2, c.pos + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new JsoncError(`invalid unicode escape at position ${c.pos}`)
        }
        value += String.fromCharCode(parseInt(hex, 16))
        c.pos += 6
        continue
      }
      const mapped = escape === undefined ? undefined : STRING_ESCAPES[escape]
      if (mapped === undefined) throw new JsoncError(`invalid escape at position ${c.pos}`)
      value += mapped
      c.pos += 2
      continue
    }
    value += char
    c.pos++
  }
}

const NUMBER_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/

function readValue(c: Cursor): JsoncNode {
  skipTrivia(c)
  const start = c.pos
  const char = c.text[c.pos]
  if (char === undefined) throw new JsoncError('unexpected end of file')

  if (char === '"') return readString(c)
  if (char === '{') return readObject(c)
  if (char === '[') return readArray(c)

  for (const [literal, value] of [
    ['true', true],
    ['false', false],
    ['null', null]
  ] as const) {
    if (c.text.startsWith(literal, c.pos)) {
      c.pos += literal.length
      return { kind: 'scalar', start, end: c.pos, value }
    }
  }

  const number = NUMBER_PATTERN.exec(c.text.slice(c.pos))
  if (number !== null) {
    c.pos += number[0].length
    return { kind: 'scalar', start, end: c.pos, value: Number(number[0]) }
  }

  throw new JsoncError(`unexpected character "${char}" at position ${c.pos}`)
}

function readObject(c: Cursor): ObjectNode {
  const start = c.pos
  expect(c, '{')
  const members: Member[] = []
  for (;;) {
    skipTrivia(c)
    if (c.text[c.pos] === '}') {
      c.pos++
      return { kind: 'object', start, end: c.pos, members }
    }
    const memberStart = c.pos
    const name = readString(c)
    skipTrivia(c)
    expect(c, ':')
    const value = readValue(c)
    members.push({ name: name.value, value, start: memberStart, end: value.end })
    skipTrivia(c)
    if (c.text[c.pos] === ',') {
      // A trailing comma is legal here; the next turn of the loop closes out.
      c.pos++
      continue
    }
    if (c.text[c.pos] !== '}') {
      expect(c, '}')
    }
  }
}

function readArray(c: Cursor): ArrayNode {
  const start = c.pos
  expect(c, '[')
  const items: JsoncNode[] = []
  for (;;) {
    skipTrivia(c)
    if (c.text[c.pos] === ']') {
      c.pos++
      return { kind: 'array', start, end: c.pos, items }
    }
    items.push(readValue(c))
    skipTrivia(c)
    if (c.text[c.pos] === ',') {
      c.pos++
      continue
    }
    if (c.text[c.pos] !== ']') {
      expect(c, ']')
    }
  }
}

/** Reads a whole document, or throws `JsoncError`. */
function readDocument(text: string): JsoncNode | null {
  const c: Cursor = { text, pos: 0 }
  skipTrivia(c)
  // A file that is empty, or only the comment header VSCode writes, is a file
  // with no bindings rather than a broken one.
  if (c.pos >= text.length) return null
  const value = readValue(c)
  skipTrivia(c)
  if (c.pos < text.length) {
    throw new JsoncError(`unexpected content after the root value at position ${c.pos}`)
  }
  return value
}

function member(node: ObjectNode, name: string): Member | undefined {
  // Later members win, matching JSON.parse on duplicate keys.
  let found: Member | undefined
  for (const m of node.members) if (m.name === name) found = m
  return found
}

function stringMember(node: ObjectNode, name: string): StringNode | undefined {
  const m = member(node, name)
  return m !== undefined && m.value.kind === 'string' ? m.value : undefined
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Trimmed source of a node, for problem messages, capped so one huge entry cannot flood the UI. */
function excerpt(text: string, node: Span): string {
  const raw = text.slice(node.start, node.end).trim()
  return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw
}

function parse(contents: string): ParseOutcome {
  let root: JsoncNode | null
  try {
    root = readDocument(contents)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `keybindings.json is not valid JSON: ${message}` }
  }

  if (root === null) return { ok: true, bindings: [], problems: [] }
  if (root.kind !== 'array') {
    return { ok: false, error: 'keybindings.json must contain an array of keybindings' }
  }

  const bindings: ParsedBinding[] = []
  const problems: ParseProblem[] = []

  for (const item of root.items) {
    if (item.kind !== 'object') {
      problems.push({ message: 'entry is not an object', detail: excerpt(contents, item) })
      continue
    }
    const commandNode = stringMember(item, 'command')
    if (commandNode === undefined || commandNode.value.trim() === '') {
      problems.push({ message: 'entry has no command', detail: excerpt(contents, item) })
      continue
    }

    const raw = commandNode.value.trim()
    const negated = raw.startsWith('-')
    const command = negated ? raw.slice(1) : raw
    if (command === '') {
      problems.push({ message: 'entry has no command', detail: excerpt(contents, item) })
      continue
    }

    const keyNode = stringMember(item, 'key')
    if (keyNode === undefined) {
      problems.push({
        message: `entry for "${raw}" has no key`,
        detail: excerpt(contents, item)
      })
      continue
    }

    const chord = decodeChord(keyNode.value)
    if (chord === null) {
      problems.push({
        message: `could not read the chord "${keyNode.value}" for "${raw}"`,
        detail: excerpt(contents, item)
      })
      continue
    }

    const binding: ParsedBinding = { command, chord, source: 'user' }
    if (negated) binding.negated = true
    bindings.push(binding)
  }

  return { ok: true, bindings, problems }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

interface Edit extends Span {
  text: string
}

/** An entry in the file that mentions one of the managed commands. */
interface Entry {
  node: ObjectNode
  /** Command with any negation `-` stripped. */
  command: string
  negated: boolean
  commandValue: StringNode
  keyValue: StringNode | undefined
}

interface Layout {
  newline: string
  /** Indentation of an entry within the array, e.g. two spaces. */
  itemIndent: string
  /** Indentation of a member within an entry. */
  memberIndent: string
}

function detectLayout(contents: string, root: ArrayNode): Layout {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const unit = /^\t/m.test(contents) ? '\t' : '  '

  const first = root.items[0]
  const itemIndent = first === undefined ? unit : indentOfLineAt(contents, first.start)

  let memberIndent = itemIndent + unit
  if (first !== undefined && first.kind === 'object' && first.members.length > 0) {
    const observed = indentOfLineAt(contents, first.members[0].start)
    // Only trust the observed indent when the member really starts its own
    // line; a one-line entry would otherwise report the entry's own indent.
    if (observed.length > itemIndent.length) memberIndent = observed
  }

  return { newline, itemIndent, memberIndent }
}

function indentOfLineAt(contents: string, position: number): string {
  const lineStart = contents.lastIndexOf('\n', position - 1) + 1
  const before = contents.slice(lineStart, position)
  return /^[ \t]*$/.test(before) ? before : ''
}

function renderEntry(key: string | null, command: string, layout: Layout): string {
  const lines = [
    '{',
    ...(key === null
      ? []
      : [`${layout.memberIndent}${JSON.stringify('key')}: ${JSON.stringify(key)},`]),
    `${layout.memberIndent}${JSON.stringify('command')}: ${JSON.stringify(command)}`,
    `${layout.itemIndent}}`
  ]
  return lines.join(layout.newline)
}

function merge(contents: string, managed: ManagedBinding[]): MergeOutcome {
  const base = contents.trim() === '' ? emptyContents() : contents

  let root: JsoncNode | null
  try {
    root = readDocument(base)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `refusing to write: keybindings.json is not valid JSON: ${message}` }
  }
  if (root === null || root.kind !== 'array') {
    return { ok: false, error: 'refusing to write: keybindings.json must contain an array' }
  }

  const entries = collectEntries(root)
  const layout = detectLayout(base, root)
  const edits: Edit[] = []
  const appended: string[] = []
  const skipped: InexpressibleChord[] = []

  for (const binding of managed) {
    const mine = entries.filter((e) => e.command === binding.command)

    if (binding.chord !== null) {
      const encoded = encodeChord(binding.chord)
      if (!encoded.ok) {
        skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
        continue
      }
      const positives = mine.filter((e) => !e.negated && e.keyValue !== undefined)
      if (positives.length === 0) {
        appended.push(renderEntry(encoded.value, binding.command, layout))
        continue
      }
      for (const entry of positives) {
        const keyValue = entry.keyValue as StringNode
        // Comparing decoded values, not source text, keeps an already-correct
        // entry byte-identical whatever escaping the user wrote it with.
        if (keyValue.value === encoded.value) continue
        edits.push({
          start: keyValue.start,
          end: keyValue.end,
          text: JSON.stringify(encoded.value)
        })
      }
      continue
    }

    // `chord: null` means unbound. Deleting the user's entry would only restore
    // VSCode's compiled-in default, so every key that could still trigger the
    // command has to be negated: the user's own entry is rewritten into a
    // negation in place (keeping its key and `when`), and the shipped default
    // is negated too if nothing already covers it.
    const negatedKeys = new Set(
      mine.filter((e) => e.negated).map((e) => (e.keyValue === undefined ? '' : e.keyValue.value))
    )
    for (const entry of mine) {
      if (entry.negated) continue
      edits.push({
        start: entry.commandValue.start,
        end: entry.commandValue.end,
        text: JSON.stringify(`-${binding.command}`)
      })
      if (entry.keyValue !== undefined) negatedKeys.add(entry.keyValue.value)
    }

    const defaultKey = DEFAULT_KEYS[binding.command]
    if (defaultKey !== undefined) {
      if (!negatedKeys.has(defaultKey)) {
        appended.push(renderEntry(defaultKey, `-${binding.command}`, layout))
        negatedKeys.add(defaultKey)
      }
    } else if (negatedKeys.size === 0) {
      // Nothing known to negate. A keyless negation still records the intent
      // rather than leaving the command silently untouched.
      appended.push(renderEntry(null, `-${binding.command}`, layout))
    }
  }

  if (appended.length > 0) edits.push(appendEdit(root, layout, appended))
  return { ok: true, contents: applyEdits(base, edits), skipped }
}

function collectEntries(root: ArrayNode): Entry[] {
  const entries: Entry[] = []
  for (const item of root.items) {
    if (item.kind !== 'object') continue
    const commandValue = stringMember(item, 'command')
    if (commandValue === undefined) continue
    const raw = commandValue.value.trim()
    if (raw === '' || raw === '-') continue
    const negated = raw.startsWith('-')
    entries.push({
      node: item,
      command: negated ? raw.slice(1) : raw,
      negated,
      commandValue,
      keyValue: stringMember(item, 'key')
    })
  }
  return entries
}

function appendEdit(root: ArrayNode, layout: Layout, rendered: string[]): Edit {
  const body = rendered.join(`,${layout.newline}${layout.itemIndent}`)
  const last = root.items[root.items.length - 1]

  if (last === undefined) {
    // Empty array: open it up rather than producing `[{ ... }]` on one line.
    const closing = root.end - 1
    const text = `${layout.newline}${layout.itemIndent}${body}${layout.newline}`
    return { start: closing, end: closing, text }
  }

  return {
    start: last.end,
    end: last.end,
    text: `,${layout.newline}${layout.itemIndent}${body}`
  }
}

function applyEdits(contents: string, edits: Edit[]): string {
  // Applied back to front so earlier offsets stay valid.
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let out = contents
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

function emptyContents(): string {
  return ['// Place your key bindings in this file to override the defaults', '[]', ''].join('\n')
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * VSCode's defaults are compiled into the application: there is no file to read
 * and no supported way to ask a running instance for them. So this is a
 * hand-authored table of well-known macOS defaults, which is why the report is
 * `partial` — a command missing from it simply has no default, never a wrong
 * one. Cursor is a VSCode fork and ships the same set.
 *
 * Chords are written in VSCode's own notation so the table can be read against
 * a real keybindings.json, and decoded through the same path as user config.
 */
const DEFAULT_KEYS: Record<string, string> = {
  // Files and windows
  'workbench.action.files.save': 'cmd+s',
  'workbench.action.files.saveAll': 'cmd+alt+s',
  'workbench.action.files.newUntitledFile': 'cmd+n',
  'workbench.action.files.openFile': 'cmd+o',
  'workbench.action.closeActiveEditor': 'cmd+w',
  'workbench.action.splitEditor': 'cmd+\\',
  'workbench.action.nextEditor': 'cmd+alt+right',
  'workbench.action.previousEditor': 'cmd+alt+left',
  // Navigation
  'workbench.action.showCommands': 'cmd+shift+p',
  'workbench.action.quickOpen': 'cmd+p',
  'workbench.action.gotoLine': 'ctrl+g',
  'workbench.action.gotoSymbol': 'cmd+shift+o',
  'workbench.action.showAllSymbols': 'cmd+t',
  'workbench.action.navigateBack': 'ctrl+-',
  // Search and replace
  'actions.find': 'cmd+f',
  'editor.action.startFindReplaceAction': 'cmd+alt+f',
  'workbench.action.findInFiles': 'cmd+shift+f',
  'workbench.action.replaceInFiles': 'cmd+shift+h',
  'editor.action.addSelectionToNextFindMatch': 'cmd+d',
  // Editing
  'editor.action.commentLine': 'cmd+/',
  'editor.action.blockComment': 'shift+alt+a',
  'editor.action.formatDocument': 'shift+alt+f',
  'editor.action.rename': 'f2',
  'editor.action.quickFix': 'cmd+.',
  'editor.action.triggerSuggest': 'ctrl+space',
  'editor.action.insertCursorBelow': 'cmd+alt+down',
  'editor.action.insertCursorAbove': 'cmd+alt+up',
  'editor.action.moveLinesDownAction': 'alt+down',
  'editor.action.moveLinesUpAction': 'alt+up',
  'editor.action.copyLinesDownAction': 'shift+alt+down',
  'editor.action.deleteLines': 'cmd+shift+k',
  'editor.action.indentLines': 'cmd+]',
  'editor.action.outdentLines': 'cmd+[',
  'editor.action.jumpToBracket': 'cmd+shift+\\',
  // Code intelligence
  'editor.action.revealDefinition': 'f12',
  'editor.action.revealDefinitionAside': 'cmd+k f12',
  'editor.action.goToReferences': 'shift+f12',
  'editor.action.marker.next': 'f8',
  'editor.action.marker.prev': 'shift+f8',
  // Workbench and terminal
  'workbench.action.toggleSidebarVisibility': 'cmd+b',
  'workbench.action.togglePanel': 'cmd+j',
  'workbench.action.toggleZenMode': 'cmd+k z',
  'workbench.action.terminal.toggleTerminal': 'ctrl+`',
  'workbench.action.terminal.new': 'ctrl+shift+`',
  'workbench.action.openSettings': 'cmd+,',
  'workbench.action.openGlobalKeybindings': 'cmd+k cmd+s',
  // Debugging
  'workbench.action.debug.start': 'f5',
  'workbench.action.debug.stepOver': 'f10',
  'workbench.action.debug.stepInto': 'f11'
}

const DEFAULTS_NOTE =
  'VSCode compiles its default keybindings into the application rather than storing ' +
  'them in a readable file, so unikeys ships a curated subset of the well-known macOS ' +
  'defaults. Commands outside that subset show no default.'

/** Takes no `app`: Cursor is a VSCode fork and ships the same defaults. */
function defaults(): DefaultsReport {
  const bindings: ParsedBinding[] = []
  for (const [command, key] of Object.entries(DEFAULT_KEYS)) {
    const chord = decodeChord(key)
    // A table entry that cannot be decoded is a bug in the table, not user
    // data; dropping it keeps a typo from surfacing as a phantom binding.
    if (chord === null) continue
    bindings.push({ command, chord, source: 'default' })
  }
  return { availability: 'partial', note: DEFAULTS_NOTE, bindings }
}

// ---------------------------------------------------------------------------

export const vscodeAdapter: Adapter = {
  format: 'vscode-keybindings',
  apps: ['vscode', 'cursor'],
  parse,
  merge,
  encodeChord,
  decodeChord,
  defaults,
  emptyContents
}
