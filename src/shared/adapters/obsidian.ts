/**
 * The Obsidian adapter.
 *
 * `<vault>/.obsidian/hotkeys.json` is strict JSON written by Obsidian itself,
 * mapping a command id to an **array** of `{ modifiers, key }` objects. Three
 * things about that shape drive every decision here:
 *
 * - The file holds **only overrides**. Obsidian's own defaults are compiled
 *   into the application, so a command absent from the file is bound to
 *   whatever Obsidian ships and unikeys cannot see it.
 * - An **empty array is an explicit unbind**, suppressing the shipped default.
 *   It is the format's own way of saying "not bound", which is why unbinding
 *   here is a rewrite to `[]` and never a deletion — deleting the member would
 *   restore the default, the opposite of what the user asked for.
 * - A command may carry several bindings. unikeys shows and rewrites the
 *   **first** and leaves the rest alone, the way the JetBrains adapter leaves
 *   alternate shortcuts alone.
 *
 * Merging is textual, through `./jsonc`, so a file the user owns keeps its
 * formatting and its unmanaged commands byte for byte.
 */

import type { Chord, KeyStroke, Modifier } from '../chord'
import { CANONICAL_KEYS, canonicalKey, normalizeModifiers, normalizeStroke } from '../chord'
import type { ArrayNode, Edit, JsoncNode, Member, ObjectNode } from './jsonc'
import { appendInto, applyEdits, excerpt, indentOfLineAt, member, readDocument } from './jsonc'
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
 * On macOS Obsidian's `Mod` **is** the Command key, and `Ctrl` is Control.
 * Writing `Ctrl` where the user asked for ⌘ would silently bind the wrong key
 * on every row, so the two tables below are the most load-bearing lines in the
 * file and are asserted against literals in both directions in the tests.
 */
const ENCODE_MODIFIERS: Record<Modifier, string> = {
  cmd: 'Mod',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift'
}

/**
 * Decoding also accepts `Meta`, which Obsidian writes for a binding made with
 * ⌘ explicitly rather than through the platform-agnostic `Mod`.
 */
const DECODE_MODIFIERS: Record<string, Modifier> = {
  mod: 'cmd',
  meta: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift'
}

/**
 * The order unikeys writes modifiers in. Obsidian compares them as a set, so
 * this is a choice about what the user reads in their own file rather than a
 * requirement — and it is why modifiers are compared as canonical sets in
 * `merge`, never as ordered text.
 */
const ENCODE_MODIFIER_ORDER: readonly Modifier[] = ['cmd', 'ctrl', 'alt', 'shift']

/**
 * Canonical key → the DOM `KeyboardEvent.key` value Obsidian records. Letters,
 * digits and punctuation are written literally (`"T"`, `"7"`, `"\\"`), so only
 * the keys whose DOM spelling is a name need a table — and they are spelled out
 * rather than derived from casing rules, because `up` → `ArrowUp` and
 * `pageup` → `PageUp` follow no rule a casing function could express.
 */
const ENCODE_KEYS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  space: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]))
}

const DECODE_KEYS: ReadonlyMap<string, string> = new Map(
  Object.entries(ENCODE_KEYS).map(([canonical, dom]) => [dom.toLowerCase(), canonical])
)

/** One Obsidian binding, the shape the file stores. */
interface ObsidianBinding {
  modifiers: string[]
  key: string
}

type BindingOutcome = { ok: true; binding: ObsidianBinding } | { ok: false; reason: string }

function encodeBinding(c: Chord): BindingOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'chord has no keystrokes' }
  if (c.strokes.length > 1) {
    // Reachable: matching a row can carry a VSCode or JetBrains two-keystroke
    // chord straight into this column.
    return { ok: false, reason: 'Obsidian hotkeys are one keystroke; it has no key sequences' }
  }

  const s = normalizeStroke(c.strokes[0])
  const key = encodeKey(s.key)
  if (key === null) return { ok: false, reason: `Obsidian has no key named "${s.key}"` }

  const held = new Set(normalizeModifiers(s.modifiers))
  const modifiers = ENCODE_MODIFIER_ORDER.filter((m) => held.has(m)).map((m) => ENCODE_MODIFIERS[m])
  return { ok: true, binding: { modifiers, key } }
}

function encodeKey(key: string): string | null {
  const named = ENCODE_KEYS[key]
  if (named !== undefined) return named
  if (!CANONICAL_KEYS.has(key)) return null
  // Letters uppercase, digits and punctuation as they are.
  return key.length === 1 ? key.toUpperCase() : null
}

function decodeBinding(modifiers: readonly string[], key: string): Chord | null {
  const held: Modifier[] = []
  for (const raw of modifiers) {
    const modifier = DECODE_MODIFIERS[raw.trim().toLowerCase()]
    // An unmodelled modifier means unikeys does not understand this binding.
    // Dropping it would put a chord in the cell that is not what Obsidian fires.
    if (modifier === undefined) return null
    held.push(modifier)
  }

  const canonical = decodeKey(key)
  if (canonical === null) return null

  const s: KeyStroke = { modifiers: normalizeModifiers(held), key: canonical }
  return { strokes: [s] }
}

function decodeKey(key: string): string | null {
  // The named keys first, and by exact DOM spelling lowercased: `" "` is the
  // space key and must be looked up before anything trims it away.
  const named = DECODE_KEYS.get(key.toLowerCase())
  if (named !== undefined) return named
  return key.length === 1 ? canonicalKey(key) : null
}

/**
 * The textual notation `encodeChord` and `decodeChord` speak.
 *
 * Obsidian stores a binding as an object, not a string, so unlike VSCode's
 * `cmd+shift+p` there is no notation in the file to reuse. This one is unikeys'
 * own: the pieces Obsidian records, joined with `+`. The one departure is the
 * space key, which Obsidian records as `" "` and which is spelled `Space` here
 * so it survives being read back out of a string. The object written to the
 * file still carries `" "`.
 */
const SPACE_IN_TEXT = 'Space'

function encodeChord(c: Chord): EncodeOutcome {
  const encoded = encodeBinding(c)
  if (!encoded.ok) return encoded
  const { modifiers, key } = encoded.binding
  return { ok: true, value: [...modifiers, key === ' ' ? SPACE_IN_TEXT : key].join('+') }
}

function decodeChord(text: string): Chord | null {
  const tokens = tokenize(text.trim())
  if (tokens.length === 0) return null

  const modifiers: string[] = []
  let key: string | null = null
  for (const token of tokens) {
    if (DECODE_MODIFIERS[token.toLowerCase()] !== undefined) {
      // A modifier after the base key is malformed rather than tolerable.
      if (key !== null) return null
      modifiers.push(token)
      continue
    }
    if (key !== null) return null
    key = token
  }

  if (key === null) return null
  return decodeBinding(modifiers, key === SPACE_IN_TEXT ? ' ' : key)
}

/**
 * Splits `Mod+Shift+\` into tokens. `+` separates only when something precedes
 * it, so `Mod++` keeps `+` as its base key.
 */
function tokenize(text: string): string[] {
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
// Parsing
// ---------------------------------------------------------------------------

function parse(contents: string): ParseOutcome {
  let root: JsoncNode | null
  try {
    root = readDocument(contents)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `hotkeys.json is not valid JSON: ${message}` }
  }

  if (root === null) return { ok: true, bindings: [], problems: [] }
  if (root.kind !== 'object') {
    return { ok: false, error: 'hotkeys.json must contain an object of command ids' }
  }

  const bindings: ParsedBinding[] = []
  const problems: ParseProblem[] = []

  for (const entry of effectiveMembers(root)) {
    const command = entry.name.trim()
    if (command === '') {
      problems.push({ message: 'an entry has no command id', detail: excerpt(contents, entry) })
      continue
    }

    if (entry.value.kind !== 'array') {
      problems.push({
        message: `the entry for "${command}" is not an array of bindings`,
        detail: excerpt(contents, entry)
      })
      continue
    }

    // An empty array is Obsidian's explicit unbind: it suppresses the shipped
    // default. Read as anything else the cell would show a chord the user has
    // deliberately removed.
    if (entry.value.items.length === 0) {
      bindings.push({ command, chord: null, source: 'user', negated: true })
      continue
    }

    // Only the first binding is managed; any alternates are the user's and are
    // neither shown nor rewritten.
    const read = readBinding(entry.value.items[0])
    if (typeof read === 'string') {
      problems.push({
        message: `the binding for "${command}" ${read}`,
        detail: excerpt(contents, entry)
      })
      continue
    }

    const chord = decodeBinding(read.modifiers, read.key)
    if (chord === null) {
      problems.push({
        message: `could not read the chord "${describe(read)}" for "${command}"`,
        detail: excerpt(contents, entry)
      })
      continue
    }

    bindings.push({ command, chord, source: 'user' })
  }

  return { ok: true, bindings, problems }
}

/**
 * The members that decide the file's meaning. JSON gives a repeated name to the
 * last one that carries it, and that is what Obsidian itself sees — showing the
 * first would put a binding in the cell the app ignores.
 */
function effectiveMembers(root: ObjectNode): Member[] {
  const last = new Map<string, Member>()
  for (const entry of root.members) last.set(entry.name, entry)
  return root.members.filter((entry) => last.get(entry.name) === entry)
}

/** The binding an array item states, or a phrase saying why it states none. */
function readBinding(node: JsoncNode): ObsidianBinding | string {
  if (node.kind !== 'object') return 'is not an object'

  const keyMember = member(node, 'key')
  if (keyMember === undefined || keyMember.value.kind !== 'string') return 'has no key'

  const modifiers: string[] = []
  const modifiersMember = member(node, 'modifiers')
  if (modifiersMember !== undefined) {
    if (modifiersMember.value.kind !== 'array') return 'has a modifiers that is not an array'
    for (const item of modifiersMember.value.items) {
      if (item.kind !== 'string') return 'has a modifier that is not a string'
      modifiers.push(item.value)
    }
  }

  return { modifiers, key: keyMember.value.value }
}

function describe(binding: ObsidianBinding): string {
  return [...binding.modifiers, binding.key].join('+')
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

interface Layout {
  newline: string
  /** One level of indentation, e.g. two spaces. */
  unit: string
  /** Indentation of a command within the root object. */
  memberIndent: string
}

function detectLayout(contents: string, root: ObjectNode): Layout {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const unit = /^\t/m.test(contents) ? '\t' : '  '
  const first = root.members[0]
  const memberIndent = first === undefined ? unit : indentOfLineAt(contents, first.start)
  return { newline, unit, memberIndent }
}

function renderBinding(binding: ObsidianBinding): string {
  const modifiers = `${JSON.stringify('modifiers')}: ${renderModifiers(binding.modifiers)}`
  return `{ ${modifiers}, ${JSON.stringify('key')}: ${JSON.stringify(binding.key)} }`
}

function renderModifiers(modifiers: readonly string[]): string {
  return `[${modifiers.map((m) => JSON.stringify(m)).join(', ')}]`
}

function renderList(binding: ObsidianBinding | null): string {
  return binding === null ? '[]' : `[${renderBinding(binding)}]`
}

function renderMember(command: string, binding: ObsidianBinding | null): string {
  return `${JSON.stringify(command)}: ${renderList(binding)}`
}

function merge(contents: string, managed: ManagedBinding[]): MergeOutcome {
  const base = contents.trim() === '' ? emptyContents() : contents

  let root: JsoncNode | null
  try {
    root = readDocument(base)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `refusing to write: hotkeys.json is not valid JSON: ${message}` }
  }
  if (root === null || root.kind !== 'object') {
    return { ok: false, error: 'refusing to write: hotkeys.json must contain an object' }
  }

  const layout = detectLayout(base, root)
  const edits: Edit[] = []
  const appended: string[] = []
  const skipped: InexpressibleChord[] = []

  for (const binding of managed) {
    // Later wins on a repeated command id, so the entry rewritten here is the
    // one Obsidian actually reads.
    const existing = member(root, binding.command)

    if (binding.chord === null) {
      // Unbinding clears every binding for the command, alternates included: an
      // alternate left behind would keep firing, which is exactly what the user
      // asked to stop.
      if (existing === undefined) {
        appended.push(renderMember(binding.command, null))
        continue
      }
      if (existing.value.kind === 'array' && existing.value.items.length === 0) continue
      edits.push({ start: existing.value.start, end: existing.value.end, text: '[]' })
      continue
    }

    const encoded = encodeBinding(binding.chord)
    if (!encoded.ok) {
      skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
      continue
    }

    if (existing === undefined) {
      appended.push(renderMember(binding.command, encoded.binding))
      continue
    }
    // A value that is not an array is not something Obsidian can read, so there
    // is nothing in it worth preserving.
    if (existing.value.kind !== 'array' || existing.value.items.length === 0) {
      edits.push({
        start: existing.value.start,
        end: existing.value.end,
        text: renderList(encoded.binding)
      })
      continue
    }

    setFirstBinding(existing.value, encoded.binding, edits)
  }

  if (appended.length > 0) {
    edits.push(appendInto(root, appended, { ...layout, indent: layout.memberIndent }))
  }
  return { ok: true, contents: applyEdits(base, edits), skipped }
}

/**
 * Rewrites the first binding of a non-empty array, in place where it can.
 *
 * Splicing the `key` and `modifiers` literals rather than the whole object is
 * what keeps a file Obsidian pretty-printed looking as Obsidian left it, and
 * what makes an already-correct entry byte-identical: both are compared by
 * meaning, so `["Meta"]` is not rewritten to `["Mod"]` and a different modifier
 * order is not churned. Anything whose shape does not admit a surgical edit —
 * an item that is not an object, a missing `modifiers` that now needs one — is
 * replaced whole.
 */
function setFirstBinding(list: ArrayNode, target: ObsidianBinding, edits: Edit[]): void {
  const item = list.items[0]
  const surgical = surgicalEdits(item, target)
  if (surgical !== null) {
    edits.push(...surgical)
    return
  }
  edits.push({ start: item.start, end: item.end, text: renderBinding(target) })
}

/**
 * The in-place edits that make `item` state `target`, or `null` when its shape
 * does not admit them and it has to be replaced whole.
 */
function surgicalEdits(item: JsoncNode, target: ObsidianBinding): Edit[] | null {
  if (item.kind !== 'object') return null

  const keyMember = member(item, 'key')
  if (keyMember === undefined || keyMember.value.kind !== 'string') return null

  const modifiersMember = member(item, 'modifiers')
  // Nothing to splice a modifier into: the item is rewritten instead.
  if (modifiersMember === undefined && target.modifiers.length > 0) return null

  const current = readBinding(item)
  if (typeof current === 'string') return null

  const edits: Edit[] = []
  if (current.key !== target.key) {
    edits.push({
      start: keyMember.value.start,
      end: keyMember.value.end,
      text: JSON.stringify(target.key)
    })
  }
  if (modifiersMember !== undefined && !sameModifiers(current.modifiers, target.modifiers)) {
    edits.push({
      start: modifiersMember.value.start,
      end: modifiersMember.value.end,
      text: renderModifiers(target.modifiers)
    })
  }
  return edits
}

/**
 * Compares modifier lists by what they mean rather than as text. Obsidian reads
 * them as a set, so order carries nothing, and `Meta` and `Mod` are the same
 * key — rewriting either would churn a file that is already correct.
 */
function sameModifiers(current: readonly string[], target: readonly string[]): boolean {
  const decode = (list: readonly string[]): string | null => {
    const modifiers: Modifier[] = []
    for (const raw of list) {
      const modifier = DECODE_MODIFIERS[raw.trim().toLowerCase()]
      if (modifier === undefined) return null
      modifiers.push(modifier)
    }
    return normalizeModifiers(modifiers).join('+')
  }

  const a = decode(current)
  const b = decode(target)
  return a !== null && b !== null && a === b
}

function emptyContents(): string {
  return '{}\n'
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

const DEFAULTS_NOTE =
  'Obsidian compiles its default hotkeys into the application and hotkeys.json holds only ' +
  'your overrides, so unikeys has no way to read them. Rows you have not changed in Obsidian ' +
  'start empty rather than wrong.'

/**
 * Nothing is claimed. Obsidian's defaults live in the application, and this
 * adapter was written without an Obsidian to check a curated table against — an
 * empty cell is honest where a guessed chord would be a lie the user only finds
 * out about by pressing the keys.
 */
function defaults(): DefaultsReport {
  return { availability: 'unavailable', note: DEFAULTS_NOTE, bindings: [] }
}

// ---------------------------------------------------------------------------

export const obsidianAdapter: Adapter = {
  format: 'obsidian-hotkeys',
  apps: ['obsidian'],
  parse,
  merge,
  encodeChord,
  decodeChord,
  defaults,
  emptyContents
}
