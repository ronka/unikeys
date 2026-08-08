/**
 * The Zed adapter — `~/.config/zed/keymap.json`.
 *
 * The file is a JSONC array of context blocks, each holding a `bindings` map,
 * and two properties of that format shape everything below.
 *
 * **The map is inverted.** Every other format unikeys reads is keyed by the
 * app's command; Zed's `bindings` is keyed by the *chord*, with the action as
 * the value. `parse` therefore walks each block and emits one `ParsedBinding`
 * per pair, turning `"cmd-s": "workspace::Save"` back into command-first form.
 * A `null` value is Zed's unbind, and it names a chord rather than an action —
 * so a null is resolved against the bindings already seen in the file and then
 * against the shipped-defaults table, and reported as `negated` for whatever
 * command held that chord. A null unikeys cannot attribute is not a problem
 * with the file; it simply unbinds something unikeys does not manage.
 *
 * **unikeys owns one appended block.** Later blocks win in Zed, so `merge`
 * rewrites a single block at the end of the array rather than reaching into the
 * user's — the same shape as the iTerm2 dynamic profile, where unikeys owns one
 * region outright. That block is found by a **marker comment**, not by an
 * invented `context`: a Zed context is semantic and is matched against the
 * focused element, so a made-up one would never match and the bindings would
 * never fire. The block therefore carries no `context` at all, which is Zed's
 * spelling for "everywhere".
 *
 * **A managed command the user has also bound themselves.** unikeys' trailing
 * block wins at runtime, so the chord the table shows is the chord that fires
 * — but the user's own binding stays in the file, because editing their blocks
 * is not this adapter's business. On the next import, `parse` reports bindings
 * in document order and `indexBindings` keeps the first per command, so a cell
 * can come back showing the user's stale chord. The marker comment says so in
 * the file; the fix is for the user to delete their own binding, not for
 * unikeys to do it for them.
 *
 * Merging is textual, through `./jsonc`, for the reason that module exists:
 * Zed's keymap permits comments, and a `JSON.parse`/`stringify` round trip
 * would throw the user's comments and formatting away.
 */

import type { AppId } from '../apps'
import type { Chord, KeyStroke, Modifier } from '../chord'
import {
  MAX_STROKES,
  canonicalKey,
  canonicalModifier,
  formatCanonical,
  normalizeModifiers
} from '../chord'
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
 * Zed matches modifier names component by component, so the order it is given
 * them in does not change what the binding does. The order here is chosen for
 * what the user will read in their own keymap: the spelling Zed's own default
 * keymap uses — `ctrl-cmd-f`, `cmd-shift-p`, `cmd-alt-s`.
 */
const ENCODE_MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'cmd', 'alt', 'shift']

/**
 * Zed spells the canonical named keys exactly as unikeys does — `escape`,
 * `enter`, `backspace`, `pageup`, `up` — and writes letters, digits,
 * punctuation and function keys literally, which is why there is no encoding
 * table here.
 */
function encodeStroke(s: KeyStroke): EncodeOutcome {
  const key = canonicalKey(s.key)
  if (key === null) return { ok: false, reason: `unknown key "${s.key}"` }

  const present = new Set(normalizeModifiers(s.modifiers))
  const parts = ENCODE_MODIFIER_ORDER.filter((m) => present.has(m))
  return { ok: true, value: [...parts, key].join('-') }
}

function encodeChord(c: Chord): EncodeOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'chord has no keystrokes' }
  if (c.strokes.length > MAX_STROKES) {
    return { ok: false, reason: `Zed supports at most ${MAX_STROKES} keystrokes` }
  }

  const parts: string[] = []
  for (const s of c.strokes) {
    const encoded = encodeStroke(s)
    if (!encoded.ok) return encoded
    parts.push(encoded.value)
  }
  return { ok: true, value: parts.join(' ') }
}

/**
 * Zed's platform-agnostic modifier. unikeys is macOS-only, where `secondary`
 * is `cmd`; `fn` has no canonical equivalent at all and falls through to the
 * key vocabulary, where it fails — which is the honest outcome, since a chord
 * unikeys cannot hold must not be shown as one it can.
 */
const EXTRA_MODIFIERS: Record<string, Modifier> = { secondary: 'cmd' }

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
    const mod = canonicalModifier(token) ?? EXTRA_MODIFIERS[token.toLowerCase()]
    if (mod !== undefined) {
      // A modifier after the base key is malformed rather than tolerable;
      // guessing risks writing a binding the user never asked for.
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
 * Splits `cmd-shift-p` into tokens. `-` separates only when something precedes
 * it, so `cmd--` keeps its punctuation base key — which is how Zed's own
 * default keymap writes the decrease-font-size binding.
 */
function tokenizeStroke(text: string): string[] {
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

/**
 * A chord's identity, independent of how it was spelled. Two entries naming
 * the same chord collide in a JSON object whatever notation each used.
 */
function chordIdentity(text: string): string | null {
  const c = decodeChord(text)
  return c === null ? null : formatCanonical(c)
}

// ---------------------------------------------------------------------------
// Reading the block structure
// ---------------------------------------------------------------------------

/** One `chord: value` pair, with the block it came from. */
interface RawEntry {
  block: ObjectNode
  bindings: ObjectNode
  entry: Member
}

/** Every binding pair in the file, in document order. */
function bindingEntries(root: ArrayNode, problems?: ParseProblem[], contents?: string): RawEntry[] {
  const found: RawEntry[] = []
  for (const item of root.items) {
    if (item.kind !== 'object') {
      if (problems !== undefined && contents !== undefined) {
        problems.push({ message: 'block is not an object', detail: excerpt(contents, item) })
      }
      continue
    }
    const bindings = member(item, 'bindings')
    // A block may legitimately carry only `context` or `use_key_equivalents`;
    // that is a block with nothing to say, not a broken one.
    if (bindings === undefined) continue
    if (bindings.value.kind !== 'object') {
      if (problems !== undefined && contents !== undefined) {
        problems.push({ message: '"bindings" is not an object', detail: excerpt(contents, item) })
      }
      continue
    }
    for (const entry of bindings.value.members) {
      found.push({ block: item, bindings: bindings.value, entry })
    }
  }
  return found
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
    return { ok: false, error: `keymap.json is not valid JSON: ${message}` }
  }

  if (root === null) return { ok: true, bindings: [], problems: [] }
  if (root.kind !== 'array') {
    return { ok: false, error: 'keymap.json must contain an array of context blocks' }
  }

  const bindings: ParsedBinding[] = []
  const problems: ParseProblem[] = []

  // Which command each chord currently answers to, so a later `null` can be
  // attributed to the binding it removes.
  const holders = new Map<string, string>()

  for (const { entry } of bindingEntries(root, problems, contents)) {
    const chord = decodeChord(entry.name)
    if (chord === null) {
      problems.push({
        message: `could not read the chord "${entry.name}"`,
        detail: excerpt(contents, entry)
      })
      continue
    }
    const identity = formatCanonical(chord)
    const value = entry.value

    if (value.kind === 'string') {
      const command = value.value.trim()
      if (command === '') {
        problems.push({
          message: `the binding for "${entry.name}" names no action`,
          detail: excerpt(contents, entry)
        })
        continue
      }
      holders.set(identity, command)
      bindings.push({ command, chord, source: 'user' })
      continue
    }

    if (value.kind === 'scalar' && value.value === null) {
      // Zed's unbind names a chord, not an action. Whatever last held the
      // chord is what it removes; failing that, whatever Zed ships on it.
      const command = holders.get(identity) ?? DEFAULT_COMMAND_BY_CHORD.get(identity)
      if (command === undefined) continue
      holders.delete(identity)
      bindings.push({ command, chord, source: 'user', negated: true })
      continue
    }

    // An action carrying arguments — `["editor::MoveToEndOfLine", { … }]`.
    // Its identity is the action *and* its arguments, and unikeys' model has
    // no room for the second half, so claiming the cell would be a lie.
    problems.push({
      message: `the binding for "${entry.name}" carries arguments, which unikeys cannot represent`,
      detail: excerpt(contents, entry)
    })
  }

  // No `defaultsSuppressed`: a user keymap layers over Zed's shipped one and
  // has no way to discard it wholesale.
  return { ok: true, bindings, problems }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * The first line is the block's identity — a second merge finds it and rewrites
 * the same block instead of appending another — so it must stay byte-stable.
 * The rest is addressed to whoever opens the file.
 */
const MARKER = '// unikeys: managed keybindings. Rewritten on every save.'

const MARKER_LINES = [
  MARKER,
  '// Zed applies later blocks over earlier ones, so these bindings win over the ones above.',
  '// unikeys never edits your own blocks: a binding you made yourself for one of these actions',
  '// stays in the file but no longer fires. Delete it there if you want it gone.'
]

interface Layout {
  newline: string
  /** One level of indentation, e.g. two spaces. */
  unit: string
  /** Indentation of a block within the array. */
  itemIndent: string
}

/** The block unikeys owns: the marker comment through the end of the block. */
interface OwnedRegion {
  /** Offset of the marker comment, where the rewritten region begins. */
  start: number
  block: ObjectNode
  bindings: ObjectNode
}

/**
 * Finds unikeys' own block, or `null` when the file has none.
 *
 * The marker is only believed when it starts its own line, only comments and
 * whitespace separate it from the block, and the block really is an object with
 * a `bindings` member. Otherwise the same text inside a string literal would be
 * enough to make merge splice over a block belonging to the user.
 */
function findOwnedRegion(contents: string, root: ArrayNode): OwnedRegion | null {
  // Searched from the end, because the marker unikeys wrote is the last thing
  // in the file, and every occurrence is checked rather than only the last: a
  // user who has quoted the marker text after the block must not shadow it.
  let from = contents.length
  for (;;) {
    const start = contents.lastIndexOf(MARKER, from)
    if (start === -1) return null
    const region = regionAt(contents, root, start)
    if (region !== null) return region
    if (start === 0) return null
    from = start - 1
  }
}

function regionAt(contents: string, root: ArrayNode, start: number): OwnedRegion | null {
  const lineStart = contents.lastIndexOf('\n', start - 1) + 1
  if (!/^[ \t]*$/.test(contents.slice(lineStart, start))) return null

  const markerEnd = start + MARKER.length
  const block = root.items.find((item) => item.start >= markerEnd)
  if (block === undefined || block.kind !== 'object') return null
  if (!isTrivia(contents.slice(markerEnd, block.start))) return null

  const bindings = member(block, 'bindings')
  if (bindings === undefined || bindings.value.kind !== 'object') return null
  return { start, block, bindings: bindings.value }
}

/** True when this text is nothing but blank space and line comments. */
function isTrivia(text: string): boolean {
  return text.split('\n').every((line) => {
    const trimmed = line.trim()
    return trimmed === '' || trimmed.startsWith('//')
  })
}

function detectLayout(contents: string, root: ArrayNode, region: OwnedRegion | null): Layout {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const unit = /^\t/m.test(contents) ? '\t' : '  '

  // The block unikeys already owns is the best evidence of where its
  // replacement should sit; failing that, the first block in the file.
  if (region !== null) return { newline, unit, itemIndent: indentOfLineAt(contents, region.start) }
  const first = root.items[0]
  return {
    newline,
    unit,
    itemIndent: first === undefined ? unit : indentOfLineAt(contents, first.start)
  }
}

/** One `chord: action` line unikeys intends the block to hold. */
interface Write {
  /** The chord as it will be written. */
  key: string
  /** Chord identity, for collision detection. */
  identity: string
  /** The managed command this line exists for. */
  owner: string
  /** `null` for the lines that suppress a chord rather than bind one. */
  chord: Chord | null
  text: string
}

function renderEntry(key: string, action: string | null): string {
  return `${JSON.stringify(key)}: ${action === null ? 'null' : JSON.stringify(action)}`
}

function renderRegion(entries: string[], layout: Layout): string {
  const blockIndent = layout.itemIndent + layout.unit
  const entryIndent = blockIndent + layout.unit
  const bindings =
    entries.length === 0
      ? '{}'
      : `{${layout.newline}${entryIndent}${entries.join(`,${layout.newline}${entryIndent}`)}` +
        `${layout.newline}${blockIndent}}`
  const block =
    `{${layout.newline}${blockIndent}"bindings": ${bindings}` +
    `${layout.newline}${layout.itemIndent}}`
  return (
    MARKER_LINES.join(`${layout.newline}${layout.itemIndent}`) +
    `${layout.newline}${layout.itemIndent}${block}`
  )
}

/**
 * Chords bound to each command *outside* unikeys' own block. An unbind has to
 * name every chord that still reaches the command, and the user's own blocks
 * are exactly where the rest of them are.
 */
function chordsOutside(root: ArrayNode, region: OwnedRegion | null): Map<string, string[]> {
  const byCommand = new Map<string, string[]>()
  for (const { bindings, entry } of bindingEntries(root)) {
    if (region !== null && bindings === region.bindings) continue
    if (entry.value.kind !== 'string') continue
    const chord = decodeChord(entry.name)
    if (chord === null) continue
    const encoded = encodeChord(chord)
    if (!encoded.ok) continue
    const command = entry.value.value.trim()
    if (command === '') continue
    const keys = byCommand.get(command)
    if (keys === undefined) byCommand.set(command, [encoded.value])
    else if (!keys.includes(encoded.value)) keys.push(encoded.value)
  }
  return byCommand
}

/**
 * The chords a command has to be stripped of when it is unbound, and equally
 * the chords a previous unbind of it will have suppressed — the same set, so
 * rebinding a command clears the `null` lines its unbinding wrote.
 */
function suppressionKeys(command: string, outside: ReadonlyMap<string, string[]>): string[] {
  const keys = [...(outside.get(command) ?? [])]
  const shipped = DEFAULT_KEYS[command]
  if (shipped !== undefined && !keys.includes(shipped)) keys.push(shipped)
  return keys
}

function merge(contents: string, managed: ManagedBinding[]): MergeOutcome {
  const base = contents.trim() === '' ? emptyContents() : contents

  let root: JsoncNode | null
  try {
    root = readDocument(base)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `refusing to write: keymap.json is not valid JSON: ${message}` }
  }
  if (root === null || root.kind !== 'array') {
    return { ok: false, error: 'refusing to write: keymap.json must contain an array' }
  }

  const region = findOwnedRegion(base, root)
  const layout = detectLayout(base, root, region)
  const outside = chordsOutside(root, region)
  const skipped: InexpressibleChord[] = []

  // What the managed bindings ask the block to say. Chord collisions are
  // settled here rather than at render time: a JSON object cannot hold the same
  // key twice, so the loser has to reach the user instead of being overwritten.
  const writes: Write[] = []
  const claimed = new Map<string, string>()
  /** Commands whose state this save decides; everything else must survive. */
  const resolved = new Set<string>()
  const unbinding: string[] = []

  for (const binding of managed) {
    if (binding.chord === null) {
      resolved.add(binding.command)
      unbinding.push(binding.command)
      continue
    }
    const encoded = encodeChord(binding.chord)
    if (!encoded.ok) {
      skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
      continue
    }
    const identity = formatCanonical(binding.chord)
    const clash = claimed.get(identity)
    if (clash !== undefined) {
      skipped.push({
        command: binding.command,
        chord: binding.chord,
        reason: `"${clash}" is being given the same shortcut in this save`
      })
      continue
    }
    claimed.set(identity, binding.command)
    resolved.add(binding.command)
    writes.push({
      key: encoded.value,
      identity,
      owner: binding.command,
      chord: binding.chord,
      text: renderEntry(encoded.value, binding.command)
    })
  }

  // Suppressions come after every binding, so an explicit binding always beats
  // a `null` that wants the same chord.
  for (const command of unbinding) {
    for (const key of suppressionKeys(command, outside)) {
      const identity = chordIdentity(key)
      if (identity === null || claimed.has(identity)) continue
      claimed.set(identity, command)
      writes.push({ key, identity, owner: command, chord: null, text: renderEntry(key, null) })
    }
  }

  // Which existing lines this save is entitled to replace: the ones naming a
  // command it is resolving, and the `null`s a previous unbinding of one of
  // those commands wrote. Everything else in the block is unikeys' own work for
  // commands this save was not given, and has to survive untouched.
  const suppressed = new Set<string>()
  for (const command of resolved) {
    for (const key of suppressionKeys(command, outside)) {
      const identity = chordIdentity(key)
      if (identity !== null) suppressed.add(identity)
    }
  }

  const existing = region === null ? [] : region.bindings.members
  const slots = existing.map((entry) => {
    if (entry.value.kind === 'string' && resolved.has(entry.value.value.trim())) {
      return { entry, slot: entry.value.value.trim() }
    }
    if (entry.value.kind === 'scalar' && entry.value.value === null) {
      const identity = chordIdentity(entry.name)
      if (identity !== null && suppressed.has(identity)) return { entry, slot: null }
    }
    return { entry, slot: undefined }
  })

  // A chord already spoken for by a line this save must not touch cannot be
  // taken, for the same reason two managed commands cannot share one.
  const held = new Map<string, string>()
  for (const { entry, slot } of slots) {
    if (slot !== undefined) continue
    const identity = chordIdentity(entry.name)
    if (identity === null) continue
    held.set(
      identity,
      entry.value.kind === 'string'
        ? `"${entry.value.value.trim()}"`
        : `an unbinding unikeys wrote for "${entry.name}"`
    )
  }

  const usable: Write[] = []
  for (const write of writes) {
    const holder = held.get(write.identity)
    if (holder === undefined) {
      usable.push(write)
      continue
    }
    if (write.chord !== null) {
      skipped.push({
        command: write.owner,
        chord: write.chord,
        reason: `${holder} already has this shortcut in unikeys' block`
      })
    }
    // A suppression that cannot be written is simply dropped: nulling a chord
    // another action holds would unbind that action instead.
  }

  // Placed into the line they are replacing wherever there is one, so a command
  // that merely changes chord does not migrate to the end of the block and a
  // re-save of unchanged content stays byte-identical.
  const taken = new Set<Write>()
  const final: string[] = []
  for (const { entry, slot } of slots) {
    if (slot === undefined) {
      final.push(base.slice(entry.start, entry.end))
      continue
    }
    const write = usable.find(
      (candidate) =>
        !taken.has(candidate) &&
        (slot === null
          ? candidate.chord === null && candidate.identity === chordIdentity(entry.name)
          : candidate.chord !== null && candidate.owner === slot)
    )
    if (write === undefined) continue
    taken.add(write)
    final.push(write.text)
  }
  for (const write of usable) {
    if (!taken.has(write)) final.push(write.text)
  }

  const rendered = renderRegion(final, layout)

  if (region !== null) {
    // Comparing rendered text against the region it replaces is what makes a
    // no-op save a true no-op, comments in the rest of the file included.
    if (base.slice(region.start, region.block.end) === rendered) {
      return { ok: true, contents: base, skipped }
    }
    const edit: Edit = { start: region.start, end: region.block.end, text: rendered }
    return { ok: true, contents: applyEdits(base, [edit]), skipped }
  }

  // Nothing to say and no block of its own yet: writing an empty one would only
  // add noise to a file unikeys has never had to touch.
  if (final.length === 0) return { ok: true, contents: base, skipped }

  const edit = appendInto(root, [rendered], {
    newline: layout.newline,
    indent: layout.itemIndent,
    unit: layout.unit
  })
  return { ok: true, contents: applyEdits(base, [edit]), skipped }
}

/**
 * What Zed writes into a keymap.json it creates, minus the commented-out
 * example: a file unikeys can append its block to on a first save.
 */
function emptyContents(): string {
  return [
    '// Zed keymap',
    '//',
    '// For information on binding keys, see the Zed online documentation:',
    '// https://zed.dev/docs/key-bindings',
    '[]',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * Zed ships its default keymap inside the application bundle
 * (`assets/keymaps/default-macos.json`), so there is no config file to read and
 * no supported way to ask a running instance. This is a hand-authored table of
 * the well-known macOS defaults, which is why the report is `partial`: an action
 * missing from it shows no default, never a wrong one.
 *
 * Chords are written in Zed's own notation so the table can be read against a
 * real keymap, and are decoded through the same path as user config.
 */
const DEFAULT_KEYS: Record<string, string> = {
  // Files and windows
  'workspace::Save': 'cmd-s',
  'workspace::SaveAll': 'cmd-alt-s',
  'workspace::NewFile': 'cmd-n',
  'workspace::NewWindow': 'cmd-shift-n',
  'workspace::Open': 'cmd-o',
  'pane::CloseActiveItem': 'cmd-w',
  'zed::ToggleFullScreen': 'ctrl-cmd-f',
  'zed::OpenSettings': 'cmd-,',
  // Navigation
  'command_palette::Toggle': 'cmd-shift-p',
  'file_finder::Toggle': 'cmd-p',
  'go_to_line::Toggle': 'ctrl-g',
  'outline::Toggle': 'cmd-shift-o',
  'project_symbols::Toggle': 'cmd-t',
  'editor::GoToDefinition': 'f12',
  // `pane::GoBack` and `pane::GoForward`, the split and pane-focus actions and
  // the tab-cycling ones are deliberately absent: they are real Zed actions,
  // which is why the catalogue maps them, but their default chords could not be
  // sourced here and an empty cell beats a wrong one.
  // Search
  'buffer_search::Deploy': 'cmd-f',
  'pane::DeploySearch': 'cmd-shift-f',
  // Editing
  'editor::Undo': 'cmd-z',
  'editor::Redo': 'cmd-shift-z',
  'editor::Cut': 'cmd-x',
  'editor::Copy': 'cmd-c',
  'editor::Paste': 'cmd-v',
  'editor::SelectAll': 'cmd-a',
  'editor::ToggleComments': 'cmd-/',
  'editor::Format': 'cmd-shift-i',
  'editor::Rename': 'f2',
  'editor::DuplicateLineDown': 'cmd-shift-d',
  // Workspace and terminal
  'workspace::ToggleLeftDock': 'cmd-b',
  'workspace::ToggleBottomDock': 'cmd-j',
  'terminal_panel::ToggleFocus': 'ctrl-`',
  'zed::IncreaseBufferFontSize': 'cmd-=',
  'zed::DecreaseBufferFontSize': 'cmd--',
  'zed::ResetBufferFontSize': 'cmd-0'
}

/**
 * The reverse lookup `parse` needs to attribute a `null`, which names a chord
 * rather than an action. Built from the same table, so it can never drift.
 */
const DEFAULT_COMMAND_BY_CHORD: ReadonlyMap<string, string> = new Map(
  Object.entries(DEFAULT_KEYS).flatMap(([command, key]) => {
    const identity = chordIdentity(key)
    return identity === null ? [] : [[identity, command] as const]
  })
)

const DEFAULTS_NOTE =
  'Zed ships its default keymap inside the application bundle rather than as a readable ' +
  'config file, so unikeys ships a curated subset of the well-known macOS defaults. ' +
  'Actions outside that subset show no default.'

function defaults(app: AppId): DefaultsReport {
  if (app !== 'zed') {
    return {
      availability: 'unavailable',
      note: `The Zed adapter has no defaults for ${app}.`,
      bindings: []
    }
  }
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

export const zedAdapter: Adapter = {
  format: 'zed-keymap',
  apps: ['zed'],
  parse,
  merge,
  encodeChord,
  decodeChord,
  defaults,
  emptyContents
}
