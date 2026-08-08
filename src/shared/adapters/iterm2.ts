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
 * **Keys are settled before anything is written.** `merge` receives only the
 * bindings being saved, not the whole table, so most of the file belongs to
 * commands it must leave exactly as they are — and their keys are therefore not
 * available. `planEntries` resolves that competition up front so a command
 * lands completely or is reported through `skipped`: a binding that cannot have
 * its key must not leave behind the `Ignore` that was to suppress its old
 * default, or the action ends up bound to nothing at all. Refusing one request
 * keeps its existing entry in place, which can block another, so the contest
 * settles rather than being decided in a single pass.
 *
 * Everything this file reads about iTerm2 itself — the action integers, the key
 * encoding, the shipped defaults — was captured from a running 3.6.11 and lives
 * in `./iterm2-capture`, so re-capturing against a later version does not mean
 * reading the parsing and merging code below.
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
  appendInto,
  applyEdits,
  excerpt,
  indentOfLineAt,
  member,
  openingIndent,
  readDocument,
  stringMember,
  type ArrayNode,
  type Edit,
  type JsoncNode,
  type Member,
  type ObjectNode
} from './jsonc'
import {
  DEFAULT_CHORDS,
  DEFAULTS_NOTE,
  FLAG_COMMAND,
  FLAG_CONTROL,
  FLAG_NUMERIC_PAD,
  FLAG_OPTION,
  FLAG_SHIFT,
  IGNORE,
  ITERM2_ACTIONS,
  ITERM2_KEYS,
  KEY_BY_CHAR,
  KEY_BY_SHIFTED_CHAR,
  KNOWN_FLAGS,
  PARENT_PROFILE_NAME,
  TOKEN_BY_ENTRY,
  UNIKEYS_PROFILE_GUID,
  UNIKEYS_PROFILE_NAME,
  entryKey,
  type EntryValue
} from './iterm2-capture'
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

/**
 * A `Keyboard Map` key under the one spelling `encodeChord` emits, so two keys
 * are compared as chords rather than as text. iTerm2's own bundle writes
 * `f702-0x280000` where unikeys writes `0xf702-0x280000`, and its UI appends a
 * virtual keycode; all three name the same physical chord, and treating them as
 * different keys would let unikeys write a second mapping for a chord that is
 * already taken. A key that does not decode keeps its source text — it still
 * blocks, it just cannot collide with anything unikeys emits.
 */
function canonicalKey(key: string): string {
  const chord = decodeChord(key)
  if (chord === null) return key
  const encoded = encodeChord(chord)
  return encoded.ok ? encoded.value : key
}

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

/**
 * One member of the key map unikeys intends to write: either an existing member
 * carried across untouched, or one unikeys is rendering itself. Keeping the two
 * apart is what lets `sameMembers` compare a kept member by identity and a
 * written one by the action it names.
 */
type PlannedEntry =
  | { kind: 'kept'; key: string; source: Member; text: string }
  | { kind: 'written'; key: string; value: EntryValue; text: string }

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

function renderEntry(key: string, value: EntryValue): string {
  return `${JSON.stringify(key)}: { "Action": ${value.action}, "Text": ${JSON.stringify(value.text)} }`
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

/**
 * What a managed command asks the key map to say, decided without reference to
 * which keys are free. These outcomes are order-independent and final: an
 * unknown command or a chord iTerm2 cannot express never becomes writable later.
 * Anything this rejects is reported through `skipped` on the way past.
 */
type Request =
  | { kind: 'bind'; command: string; chord: Chord; key: string; value: EntryValue }
  | { kind: 'unbind'; command: string }

function requestFor(binding: ManagedBinding, skipped: InexpressibleChord[]): Request | null {
  const entry = ITERM2_ACTIONS[binding.command]
  if (entry === undefined) {
    // A null chord for an unknown command asks for nothing, so there is nothing
    // to report.
    if (binding.chord !== null) {
      skipped.push({
        command: binding.command,
        chord: binding.chord,
        reason: `"${binding.command}" is not an iTerm2 action unikeys knows`
      })
    }
    return null
  }

  if (binding.chord === null) return { kind: 'unbind', command: binding.command }

  const encoded = encodeChord(binding.chord)
  if (!encoded.ok) {
    skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
    return null
  }
  return {
    kind: 'bind',
    command: binding.command,
    chord: binding.chord,
    key: encoded.value,
    value: { action: entry.action, text: entry.text }
  }
}

/**
 * Which existing keys are still spoken for, given the requests that are going
 * ahead. `null` marks a key held by something unikeys does not manage — a
 * hand-added mapping, or a member it could not read.
 */
function occupiedKeys(
  requests: readonly Request[],
  holders: ReadonlyMap<string, string | null>,
  refused: ReadonlyMap<string, string>
): Map<string, string | null> {
  const going = new Set(requests.filter((r) => !refused.has(r.command)).map((r) => r.command))
  const occupied = new Map<string, string | null>()
  for (const [key, token] of holders) {
    // A binding this save is rewriting vacates its key; everything else stays.
    if (token !== null && going.has(token)) continue
    occupied.set(key, token)
  }
  return occupied
}

/** What unikeys wants the key map to say, given the bindings it manages. */
interface Plan {
  /** The members unikeys writes, in order. */
  entries: Array<{ key: string; value: EntryValue }>
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

function planEntries(managed: ManagedBinding[], holders: ReadonlyMap<string, string | null>): Plan {
  const skipped: InexpressibleChord[] = []
  const requests: Request[] = []
  for (const binding of managed) {
    const request = requestFor(binding, skipped)
    if (request !== null) requests.push(request)
  }

  // Settle the fight over keys before writing anything, so a command lands
  // completely or not at all — a binding that fails here must not leave its
  // default-suppression behind.
  //
  // Refusing a request leaves *its* existing entry in place, which can in turn
  // block another request, so one pass is not enough. Each round only ever adds
  // refusals, so this runs at most once per request and then settles.
  const refused = new Map<string, string>()
  const claims = new Map<string, string>()
  let occupied = occupiedKeys(requests, holders, refused)

  for (;;) {
    claims.clear()
    let changed = false

    for (const request of requests) {
      if (request.kind !== 'bind' || refused.has(request.command)) continue

      if (occupied.has(request.key)) {
        const holder = occupied.get(request.key)
        refused.set(
          request.command,
          holder == null
            ? 'a mapping added by hand in iTerm2 already uses this shortcut'
            : `${ITERM2_ACTIONS[holder].label} already uses this shortcut in iTerm2`
        )
        changed = true
        continue
      }

      const clash = claims.get(request.key)
      if (clash !== undefined) {
        // A JSON object cannot hold the same key twice, so this is a real loss
        // and has to reach the user rather than be silently overwritten.
        refused.set(
          request.command,
          `${ITERM2_ACTIONS[clash].label} already uses this shortcut in iTerm2`
        )
        changed = true
        continue
      }
      claims.set(request.key, request.command)
    }

    if (!changed) break
    occupied = occupiedKeys(requests, holders, refused)
  }

  const entries: Array<{ key: string; value: EntryValue }> = []
  const owned = new Set<string>()
  const resolved = new Set<string>()
  // Collected and applied after every binding, so an explicit binding always
  // beats a default-suppression that wants the same key.
  const suppressions: string[] = []

  for (const request of requests) {
    const refusal = refused.get(request.command)
    if (refusal !== undefined) {
      // Only a `bind` is ever refused — an unbind claims no key — so there is
      // always a chord to name.
      const bind = request as Extract<Request, { kind: 'bind' }>
      skipped.push({ command: bind.command, chord: bind.chord, reason: refusal })
      continue
    }

    resolved.add(request.command)
    if (request.kind === 'bind') {
      owned.add(request.key)
      entries.push({ key: request.key, value: request.value })
    }

    // Without this a profile key map only ever *adds* bindings, so a moved or
    // cleared action would still answer its original key.
    const shipped = defaultEncodedKey(request.command)
    if (shipped !== null && (request.kind === 'unbind' || shipped !== request.key)) {
      owned.add(shipped)
      suppressions.push(shipped)
    }
  }

  const suppressed = new Set<string>()
  for (const key of suppressions) {
    // An explicit binding, or an entry that is staying put, keeps the key.
    if (claims.has(key) || occupied.has(key) || suppressed.has(key)) continue
    suppressed.add(key)
    entries.push({ key, value: IGNORE })
  }

  return { entries, skipped, owned, resolved }
}

/**
 * Where the rendered key map goes: over the existing one, or into whichever
 * level the file is missing.
 */
function placeKeyboardMap(
  base: string,
  profiles: ArrayNode,
  profile: ObjectNode | null,
  map: ObjectNode | null,
  rendered: string[],
  layout: Layout
): Edit {
  if (map !== null) {
    return {
      start: map.start,
      end: map.end,
      text: renderMap(rendered, layout, openingIndent(base, map))
    }
  }

  if (profile !== null) {
    const indent = memberIndent(base, profile, openingIndent(base, profile) + layout.unit)
    const text = `"Keyboard Map": ${renderMap(rendered, layout, indent)}`
    return appendInto(profile, [text], { ...layout, indent })
  }

  const first = profiles.items[0]
  const indent =
    first === undefined
      ? openingIndent(base, profiles) + layout.unit
      : indentOfLineAt(base, first.start) || openingIndent(base, profiles) + layout.unit
  return appendInto(profiles, [renderProfile(rendered, layout, indent)], { ...layout, indent })
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

  // Who holds each key already, under the spelling `encodeChord` would use.
  // `null` is a mapping the user added by hand or a member unikeys could not
  // read — either way it is not unikeys' to take. `Ignore` entries are left out
  // entirely: unikeys is the only writer of those, so they never stand in the
  // way of its own bindings.
  const holders = new Map<string, string | null>()
  for (const { entry, read } of existing) {
    if (typeof read === 'string') {
      holders.set(canonicalKey(entry.name), null)
      continue
    }
    if (read.action === IGNORE.action) continue
    holders.set(canonicalKey(entry.name), TOKEN_BY_ENTRY.get(entryKey(read)) ?? null)
  }

  const { entries, skipped, owned, resolved } = planEntries(managed, holders)

  // Everything unikeys is not resolving this save survives verbatim — source
  // text, not a re-render — so any Version, Label or Escaping member it carries
  // comes through untouched.
  const kept: PlannedEntry[] = []
  for (const { entry, read } of existing) {
    if (typeof read !== 'string') {
      const token = TOKEN_BY_ENTRY.get(entryKey(read))
      const isOurs =
        (token !== undefined && resolved.has(token)) ||
        (read.action === IGNORE.action && owned.has(canonicalKey(read.key)))
      if (isOurs) continue
    }
    kept.push({
      kind: 'kept',
      key: entry.name,
      source: entry,
      text: base.slice(entry.start, entry.end)
    })
  }

  // Whatever spelling a key already has in the file wins over the one
  // `encodeChord` would pick, so re-saving a binding the file already states
  // does not quietly renormalise `f702-0x280000` into `0xf702-0x280000`. Without
  // this, byte-identical round-tripping would hold only for files unikeys wrote
  // itself.
  const spelling = new Map<string, string>()
  for (const { entry } of existing) {
    const canonical = canonicalKey(entry.name)
    if (!spelling.has(canonical)) spelling.set(canonical, entry.name)
  }

  // No filtering here: `planEntries` refuses any key a kept entry still holds,
  // and an `Ignore` that unikeys is taking over is dropped by `owned` above, so
  // the two lists cannot name the same key.
  const written: PlannedEntry[] = entries.map(({ key, value }) => {
    const name = spelling.get(key) ?? key
    return { kind: 'written', key: name, value, text: renderEntry(name, value) }
  })

  const final = [...kept, ...written]

  // Nothing to say. Comparing decoded actions rather than source text keeps an
  // already-correct file byte-identical whatever formatting it was written with,
  // which is what makes a no-op save a true no-op.
  if (map !== null && sameMembers(map, final)) {
    return { ok: true, contents: base, skipped }
  }

  const edit = placeKeyboardMap(
    base,
    profiles.value,
    profile,
    map,
    final.map((entry) => entry.text),
    layout
  )
  return { ok: true, contents: applyEdits(base, [edit]), skipped }
}

/** True when the key map already holds exactly these members, in this order. */
function sameMembers(map: ObjectNode, final: PlannedEntry[]): boolean {
  if (map.members.length !== final.length) return false
  return map.members.every((entry, i) => {
    const planned = final[i]
    // A kept member came from this very map, so identity is the member itself.
    if (planned.kind === 'kept') return planned.source === entry
    if (entry.name !== planned.key) return false
    const read = readEntry(entry)
    return typeof read !== 'string' && entryKey(read) === entryKey(planned.value)
  })
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
  decodeChord,

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
