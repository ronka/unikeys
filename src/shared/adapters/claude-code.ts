/**
 * The Claude Code adapter — the standalone terminal interface, not Claude
 * Desktop. `~/.claude/keybindings.json` is Anthropic's officially documented,
 * versioned public contract: https://code.claude.com/docs/en/keybindings
 * (accessed 2026-08-26, against an installed `claude --version` of `2.1.246`).
 * See `__fixtures__/claude-code/README.md` for exactly what was verified
 * against a real, live instance and how.
 *
 * The file's direction is the **inverse** of unikeys' own model: it maps a
 * keystroke to an action (`{ "ctrl+e": "chat:externalEditor" }`), grouped into
 * blocks that each own a context. unikeys' commands here are compound tokens
 * of the adapter's own invention, `<Context>|<namespace:action>` — the same
 * kind of adapter-owned token iTerm2 already uses — because "the same action
 * name in two different contexts" is genuinely two different things Claude
 * Code can bind differently (see `Confirmation`'s `confirm:no` versus
 * `Settings`'s reused `confirm:no`, which behave differently by context).
 *
 * Three things about the inverted shape drive every decision here:
 *
 * - A **context's bindings live across possibly several blocks.** Live-verified
 *   against a real install: two blocks sharing a context merge, and on a
 *   literal keystroke collision the **last** one wins, with a warning — never
 *   a hard error, never first-wins. See the fixtures README for the exact
 *   debug-log evidence.
 * - Because identity is the *keystroke*, not the action, "moving" a binding
 *   means removing one member and adding another rather than editing a value
 *   in place — the same structural problem iTerm2's `Keyboard Map` has, solved
 *   the same way: a `"bindings"` object whose *membership* changes is rewritten
 *   as a whole rather than spliced member by member, since `./jsonc`'s
 *   `Member` records do not carry a separate span for the key alone and
 *   correct comma bookkeeping for a partial object edit is exactly what
 *   `iterm2.ts`'s own module comment says to avoid. An object that only changes
 *   *values* keeps its own formatting and is spliced in place instead. The one
 *   rule both paths obey: **at most one edit per `"bindings"` object.** A save
 *   carries every changed cell for the app at once, so two managed bindings
 *   routinely land in one object, and an edit nested inside another shifts the
 *   outer one's offsets as `applyEdits` splices — which truncates the file.
 * - Claude Code's `null` means "unbind the **default** shortcut at this exact
 *   keystroke", not "this action has no binding" — the file holds no direct
 *   pointer from a null entry back to the action it silences, so reading one
 *   requires resolving `(context, keystroke)` against a curated table of
 *   Claude Code's own shipped defaults. An unresolvable null is preserved and
 *   reported rather than guessed at.
 *
 * `meta` means **Option** on macOS here, the opposite of what the shared
 * `canonicalModifier` in `../chord` resolves it to for VSCode-style formats —
 * this adapter never calls that shared modifier table and keeps its own,
 * exactly as `obsidian.ts` does for its own divergent `Meta`/`Mod` split.
 */

import type { AppId } from '../apps'
import {
  MAX_STROKES,
  canonicalKey,
  chord,
  normalizeModifiers,
  normalizeStroke,
  stroke,
  type Chord,
  type KeyStroke,
  type Modifier
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
// Compound command tokens
// ---------------------------------------------------------------------------

export interface ClaudeToken {
  context: string
  action: string
}

export function splitToken(token: string): ClaudeToken | null {
  const i = token.indexOf('|')
  if (i <= 0 || i === token.length - 1) return null
  return { context: token.slice(0, i), action: token.slice(i + 1) }
}

export function formatToken(context: string, action: string): string {
  return `${context}|${action}`
}

// ---------------------------------------------------------------------------
// Chord translation
// ---------------------------------------------------------------------------

const ENCODE_MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'cmd', 'alt', 'shift']

/** `alt` is unikeys' canonical name for the Option key; Claude Code spells it `meta`. */
const ENCODE_MODIFIER_NAMES: Record<Modifier, string> = {
  ctrl: 'ctrl',
  cmd: 'cmd',
  alt: 'meta',
  shift: 'shift'
}

/**
 * Every alias the docs list. `alt`/`opt`/`option` are accepted on read even
 * though `meta` is the only spelling this adapter ever writes, and `cmd`'s
 * synonyms (`command`, `super`, `win`) are accepted for the same reason.
 */
const DECODE_MODIFIERS: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  meta: 'alt',
  cmd: 'cmd',
  command: 'cmd',
  super: 'cmd',
  win: 'cmd'
}

/**
 * The docs' "Special keys" list is short and explicit — Home, End, PageUp,
 * PageDown, Insert and function keys are conspicuously absent, so they are
 * treated as unsupported here rather than guessed at. Letters, digits and
 * punctuation are written literally lowercase and need no table.
 */
const ENCODE_KEYS: Record<string, string> = {
  enter: 'enter',
  escape: 'escape',
  tab: 'tab',
  space: 'space',
  backspace: 'backspace',
  delete: 'delete',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right'
}

const DECODE_KEYS: ReadonlyMap<string, string> = new Map([
  ...Object.entries(ENCODE_KEYS).map(([canonical, claude]) => [claude, canonical] as const),
  ['esc', 'escape'],
  ['return', 'enter']
])

function encodeKey(key: string): string | null {
  const named = ENCODE_KEYS[key]
  if (named !== undefined) return named
  return key.length === 1 ? key : null
}

function decodeKey(text: string): string | null {
  const lower = text.toLowerCase()
  const named = DECODE_KEYS.get(lower)
  if (named !== undefined) return named
  return lower.length === 1 ? canonicalKey(lower) : null
}

/**
 * Confirmed by attempting to rebind `ctrl+c` against a real install: Claude
 * Code logs `[error] "ctrl+c" may not work: Cannot be rebound - used for
 * interrupt/exit (hardcoded)` and keeps the old binding. `ctrl+d` shares the
 * same reason in the docs; `ctrl+m` is reserved because it is identical to
 * Enter in every terminal, not because Claude Code hardcodes an action to it.
 */
const RESERVED: ReadonlyMap<string, string> = new Map([
  ['ctrl+c', '"ctrl+c" cannot be rebound: hardcoded interrupt/cancel'],
  ['ctrl+d', '"ctrl+d" cannot be rebound: hardcoded exit'],
  ['ctrl+m', '"ctrl+m" cannot be rebound: identical to Enter in every terminal']
])

function encodeStroke(s: KeyStroke): EncodeOutcome {
  const n = normalizeStroke(s)
  const key = encodeKey(n.key)
  if (key === null) return { ok: false, reason: `Claude Code has no key named "${n.key}"` }
  const held = new Set(n.modifiers)
  const parts = ENCODE_MODIFIER_ORDER.filter((m) => held.has(m)).map(
    (m) => ENCODE_MODIFIER_NAMES[m]
  )
  return { ok: true, value: [...parts, key].join('+') }
}

/**
 * The keystroke text for a chord with no reserved-shortcut check — used to
 * compute the display text of a curated default (reading and showing what
 * `ctrl+c` already means is not the same operation as asking to rebind it to
 * something else, which is what the reserved check below guards against).
 */
function encodeStrokesUnchecked(c: Chord): EncodeOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'the chord has no keystrokes' }
  if (c.strokes.length > MAX_STROKES) {
    return { ok: false, reason: `Claude Code supports at most ${MAX_STROKES} keystrokes` }
  }
  const parts: string[] = []
  for (const s of c.strokes) {
    const encoded = encodeStroke(s)
    if (!encoded.ok) return encoded
    parts.push(encoded.value)
  }
  return { ok: true, value: parts.join(' ') }
}

function encodeChord(c: Chord): EncodeOutcome {
  const unchecked = encodeStrokesUnchecked(c)
  if (!unchecked.ok) return unchecked
  const reservedReason = RESERVED.get(unchecked.value)
  if (reservedReason !== undefined) return { ok: false, reason: reservedReason }
  return unchecked
}

function decodeStroke(text: string): KeyStroke | null {
  const tokens = text.split('+')
  if (tokens.length === 0 || tokens.some((t) => t === '')) return null

  const modifiers: Modifier[] = []
  let key: string | null = null
  for (const token of tokens) {
    const mod = DECODE_MODIFIERS[token.trim().toLowerCase()]
    if (mod !== undefined) {
      if (key !== null) return null
      modifiers.push(mod)
      continue
    }
    if (key !== null) return null
    key = decodeKey(token.trim())
    if (key === null) return null
  }
  if (key === null) return null
  return { modifiers: normalizeModifiers(modifiers), key }
}

function decodeChord(text: string): Chord | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const strokeTexts = trimmed.split(/\s+/)
  if (strokeTexts.length > MAX_STROKES) return null
  const strokes: KeyStroke[] = []
  for (const st of strokeTexts) {
    const s = decodeStroke(st)
    if (s === null) return null
    strokes.push(s)
  }
  return { strokes }
}

// ---------------------------------------------------------------------------
// Curated actions and their shipped defaults
// ---------------------------------------------------------------------------

/**
 * Every default here was read directly off the live docs' action tables, not
 * guessed from a label. `alt` in `stroke()` is unikeys' canonical Option key,
 * which `encodeChord` spells `meta` — see the module comment.
 */
const CURATED_DEFAULT_CHORDS: Record<string, Chord> = {
  [formatToken('Chat', 'chat:submit')]: chord(stroke('enter')),
  [formatToken('Chat', 'chat:newline')]: chord(stroke('j', 'ctrl')),
  [formatToken('Chat', 'chat:modelPicker')]: chord(stroke('p', 'alt')),
  [formatToken('Global', 'app:interrupt')]: chord(stroke('c', 'ctrl')),
  [formatToken('Global', 'app:toggleTranscript')]: chord(stroke('o', 'ctrl'))
}

/**
 * `CURATED_DEFAULT_CHORDS` encoded through this adapter's own `encodeChord`,
 * so the keystroke text used for null-inversion lookups can never drift from
 * the chords `defaults()` reports.
 */
const CURATED_DEFAULT_KEYSTROKES: Record<string, string> = Object.fromEntries(
  Object.entries(CURATED_DEFAULT_CHORDS).map(([token, c]) => {
    const encoded = encodeStrokesUnchecked(c)
    if (!encoded.ok) throw new Error(`internal: curated default for ${token} cannot be encoded`)
    return [token, encoded.value]
  })
)

/** Reverse lookup: `context keystroke` → the token whose default that is. */
const DEFAULT_SLOTS: ReadonlyMap<string, string> = new Map(
  Object.entries(CURATED_DEFAULT_KEYSTROKES).map(([token, keystroke]) => {
    const { context } = splitToken(token) as ClaudeToken
    return [slotKey(context, keystroke), token]
  })
)

function slotKey(context: string, keystroke: string): string {
  return `${context} ${keystroke}`
}

export const CLAUDE_CODE_ACTIONS: ReadonlySet<string> = new Set(Object.keys(CURATED_DEFAULT_CHORDS))

// ---------------------------------------------------------------------------
// Reading the document into a flat, order-preserving entry list
// ---------------------------------------------------------------------------

interface RawEntry {
  context: string
  /** Lowercased, as Claude Code parses keys case-insensitively. */
  keystroke: string
  block: ObjectNode
  bindingsObj: ObjectNode
  member: Member
}

/** A member's keystroke in the form Claude Code compares by: trimmed, lowercased. */
function memberKeystroke(m: Member): string {
  return m.name.trim().toLowerCase()
}

function collectRawEntries(array: ArrayNode): RawEntry[] {
  const out: RawEntry[] = []
  for (const block of array.items) {
    if (block.kind !== 'object') continue
    const contextNode = stringMember(block, 'context')
    if (contextNode === undefined) continue
    const context = contextNode.value.trim()
    if (context === '') continue
    const inner = member(block, 'bindings')
    if (inner === undefined || inner.value.kind !== 'object') continue
    for (const m of inner.value.members) {
      const keystroke = memberKeystroke(m)
      if (keystroke === '') continue
      out.push({ context, keystroke, block, bindingsObj: inner.value, member: m })
    }
  }
  return out
}

/** The winning entry for each `(context, keystroke)`: later occurrences win, live-verified. */
function effectiveEntries(raw: readonly RawEntry[]): Map<string, RawEntry> {
  const map = new Map<string, RawEntry>()
  for (const e of raw) map.set(slotKey(e.context, e.keystroke), e)
  return map
}

/**
 * The primary entry for `(context, action)`: the first keystroke, in file
 * order, whose *currently effective* value is `action`. A keystroke that was
 * later overwritten to name a different action is not a candidate, even if it
 * named `action` originally.
 */
function primaryEntryForAction(
  raw: readonly RawEntry[],
  effective: ReadonlyMap<string, RawEntry>,
  context: string,
  action: string
): RawEntry | undefined {
  const seen = new Set<string>()
  for (const e of raw) {
    if (e.context !== context) continue
    const key = slotKey(e.context, e.keystroke)
    if (seen.has(key)) continue
    seen.add(key)
    const winner = effective.get(key)
    if (
      winner !== undefined &&
      winner.member.value.kind === 'string' &&
      winner.member.value.value.trim() === action
    ) {
      return winner
    }
  }
  return undefined
}

function isNullValue(m: Member | undefined): boolean {
  return m !== undefined && m.value.kind === 'scalar' && m.value.value === null
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parse(contents: string): ParseOutcome {
  if (contents.trim() === '') return { ok: true, bindings: [], problems: [] }

  let root: JsoncNode | null
  try {
    root = readDocument(contents)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `keybindings.json is not valid JSON: ${message}` }
  }
  if (root === null) return { ok: true, bindings: [], problems: [] }
  if (root.kind !== 'object') {
    return { ok: false, error: 'keybindings.json must contain an object' }
  }

  const bindingsMember = member(root, 'bindings')
  if (bindingsMember === undefined) return { ok: true, bindings: [], problems: [] }
  if (bindingsMember.value.kind !== 'array') {
    return { ok: false, error: '"bindings" must be an array of context blocks' }
  }

  const problems: ParseProblem[] = []

  for (const block of bindingsMember.value.items) {
    if (block.kind !== 'object') {
      problems.push({
        message: 'a bindings entry is not an object',
        detail: excerpt(contents, block)
      })
      continue
    }
    const contextNode = stringMember(block, 'context')
    if (contextNode === undefined || contextNode.value.trim() === '') {
      problems.push({
        message: 'a bindings entry has no "context"',
        detail: excerpt(contents, block)
      })
      continue
    }
    const inner = member(block, 'bindings')
    if (inner === undefined || inner.value.kind !== 'object') {
      problems.push({
        message: `the "${contextNode.value}" block has no "bindings" object`,
        detail: excerpt(contents, block)
      })
      continue
    }
    for (const m of inner.value.members) {
      if (m.name.trim() === '') {
        problems.push({
          message: `a binding in "${contextNode.value}" has an empty keystroke`,
          detail: excerpt(contents, m)
        })
        continue
      }
      const isNull = m.value.kind === 'scalar' && m.value.value === null
      const isAction = m.value.kind === 'string' && m.value.value.trim() !== ''
      if (!isNull && !isAction) {
        problems.push({
          message: `the binding for "${m.name}" in "${contextNode.value}" is not a string action or null`,
          detail: excerpt(contents, m)
        })
      }
    }
  }

  const raw = collectRawEntries(bindingsMember.value)
  const effective = effectiveEntries(raw)

  const bindings: ParsedBinding[] = []
  for (const token of CLAUDE_CODE_ACTIONS) {
    const parsedToken = splitToken(token) as ClaudeToken
    const primary = primaryEntryForAction(raw, effective, parsedToken.context, parsedToken.action)
    if (primary !== undefined) {
      const c = decodeChord(primary.keystroke)
      if (c === null) {
        problems.push({
          message: `could not read the keystroke "${primary.keystroke}" for "${token}"`,
          detail: excerpt(contents, primary.member)
        })
        continue
      }
      bindings.push({ command: token, chord: c, source: 'user' })
      continue
    }

    const def = CURATED_DEFAULT_KEYSTROKES[token]
    if (def === undefined) continue
    const atDefault = effective.get(slotKey(parsedToken.context, def))
    if (atDefault !== undefined && isNullValue(atDefault.member)) {
      bindings.push({ command: token, chord: null, source: 'user', negated: true })
    }
  }

  // A null that does not sit at any curated default's keystroke cannot be
  // attributed to a known action. Preserved either way — parsing never
  // rewrites — but surfaced rather than silently invisible.
  for (const e of effective.values()) {
    if (!isNullValue(e.member)) continue
    if (DEFAULT_SLOTS.has(slotKey(e.context, e.keystroke))) continue
    problems.push({
      message: `"${e.keystroke}" is unbound in "${e.context}" but does not match a default unikeys recognises`,
      detail: excerpt(contents, e.member)
    })
  }

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

function renderKeystrokeMember(keystroke: string, valueText: string): string {
  return `${JSON.stringify(keystroke)}: ${valueText}`
}

/**
 * One keystroke this merge wants the file to hold, before it is known whether
 * the object it lands in already has a member for that keystroke. Kept as data
 * rather than rendered text because that question can only be settled once
 * every managed binding has had its say — see `resolveAdditions`.
 */
interface PendingAddition {
  keystroke: string
  valueText: string
}

/** Last request for a keystroke wins, at the position the first one claimed. */
function dedupeAdditions(additions: readonly PendingAddition[]): PendingAddition[] {
  const byKeystroke = new Map<string, string>()
  for (const a of additions) byKeystroke.set(a.keystroke, a.valueText)
  return Array.from(byKeystroke, ([keystroke, valueText]) => ({ keystroke, valueText }))
}

/**
 * The source of one member with a new value spliced over the old one. Slicing
 * up to `value.start` rather than re-rendering the name keeps the member's own
 * spelling, spacing and escaping exactly as the user wrote it.
 */
function memberWithValue(base: string, m: Member, valueText: string): string {
  return base.slice(m.start, m.value.start) + valueText
}

function rewriteBindingsObject(
  base: string,
  objNode: ObjectNode,
  keep: readonly Member[],
  overrides: ReadonlyMap<Member, string>,
  added: readonly string[],
  layout: Layout
): string {
  const closeIndent = openingIndent(base, objNode)
  const memberIndent =
    objNode.members.length > 0
      ? indentOfLineAt(base, objNode.members[0].start) || closeIndent + layout.unit
      : closeIndent + layout.unit
  const all = [
    ...keep.map((m) => {
      const override = overrides.get(m)
      return override === undefined
        ? base.slice(m.start, m.end)
        : memberWithValue(base, m, override)
    }),
    ...added
  ]
  if (all.length === 0) return '{}'
  return `{${layout.newline}${memberIndent}${all.join(`,${layout.newline}${memberIndent}`)}${layout.newline}${closeIndent}}`
}

function renderNewBlock(
  context: string,
  added: readonly string[],
  layout: Layout,
  indent: string
): string {
  const inner = indent + layout.unit
  const bindingsInner = inner + layout.unit
  const bindingsBody =
    added.length === 0
      ? '{}'
      : `{${layout.newline}${bindingsInner}${added.join(`,${layout.newline}${bindingsInner}`)}${layout.newline}${inner}}`
  return [
    '{',
    `${inner}${JSON.stringify('context')}: ${JSON.stringify(context)},`,
    `${inner}${JSON.stringify('bindings')}: ${bindingsBody}`,
    `${indent}}`
  ].join(layout.newline)
}

function arrayItemIndent(base: string, arr: ArrayNode, layout: Layout): string {
  const first = arr.items[0]
  return first === undefined ? layout.unit : indentOfLineAt(base, first.start)
}

function rootMemberIndent(base: string, root: ObjectNode, layout: Layout): string {
  const first = root.members[0]
  return first === undefined ? layout.unit : indentOfLineAt(base, first.start)
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
  if (root === null || root.kind !== 'object') {
    return { ok: false, error: 'refusing to write: keybindings.json must contain an object' }
  }

  const existingBindings = member(root, 'bindings')
  if (existingBindings !== undefined && existingBindings.value.kind !== 'array') {
    return { ok: false, error: 'refusing to write: "bindings" must be an array of context blocks' }
  }
  const array = existingBindings?.value as ArrayNode | undefined

  const layout = detectLayout(base)
  const skipped: InexpressibleChord[] = []

  const raw = array === undefined ? [] : collectRawEntries(array)
  const effective = effectiveEntries(raw)

  const objOverrides = new Map<ObjectNode, Map<Member, string>>()
  const objRemovals = new Map<ObjectNode, Set<Member>>()
  const objAdditions = new Map<ObjectNode, PendingAddition[]>()
  const newBlockAdditions = new Map<string, PendingAddition[]>()

  function additionTarget(context: string): ObjectNode | null {
    let found: ObjectNode | null = null
    if (array !== undefined) {
      for (const block of array.items) {
        if (block.kind !== 'object') continue
        const c = stringMember(block, 'context')
        if (c === undefined || c.value.trim() !== context) continue
        const inner = member(block, 'bindings')
        if (inner !== undefined && inner.value.kind === 'object') found = inner.value
      }
    }
    return found
  }

  function addTo(context: string, keystroke: string, valueText: string): void {
    const target = additionTarget(context)
    const addition: PendingAddition = { keystroke, valueText }
    if (target !== null) {
      const list = objAdditions.get(target) ?? []
      list.push(addition)
      objAdditions.set(target, list)
    } else {
      const list = newBlockAdditions.get(context) ?? []
      list.push(addition)
      newBlockAdditions.set(context, list)
    }
  }

  function removeEntry(e: RawEntry): void {
    const set = objRemovals.get(e.bindingsObj) ?? new Set<Member>()
    set.add(e.member)
    objRemovals.set(e.bindingsObj, set)
  }

  function overrideValue(e: RawEntry, valueText: string): void {
    const map = objOverrides.get(e.bindingsObj) ?? new Map<Member, string>()
    map.set(e.member, valueText)
    objOverrides.set(e.bindingsObj, map)
  }

  /**
   * Leaves a `null` at a curated default's keystroke so the shipped default
   * does not apply again. An empty slot *is* the default, so both a move and an
   * unbind have to claim the slot they leave behind or the action ends up
   * answering to two keys. `vacating` is the entry this write removes: it still
   * occupies the slot in the parsed document but will not in the output.
   */
  function suppressDefault(context: string, def: string, vacating?: RawEntry): void {
    const atDefault = effective.get(slotKey(context, def))
    // Anything else already sitting there has overridden the default on its
    // own account, and is data unikeys does not own.
    if (atDefault === undefined || atDefault === vacating) addTo(context, def, 'null')
  }

  for (const binding of managed) {
    const token = splitToken(binding.command)
    // Not a token this adapter understands (a stray write attempt from a
    // future catalogue row); nothing here can represent it.
    if (token === null) continue
    const { context, action } = token
    const current = primaryEntryForAction(raw, effective, context, action)
    const def = CURATED_DEFAULT_KEYSTROKES[binding.command]

    if (binding.chord === null) {
      if (current !== undefined) {
        if (def !== undefined && current.keystroke === def) {
          if (!isNullValue(current.member)) overrideValue(current, 'null')
        } else {
          removeEntry(current)
          if (def !== undefined) suppressDefault(context, def, current)
        }
      } else if (def !== undefined) {
        // Already null, or the slot holds an unrelated custom mapping: left
        // untouched either way.
        suppressDefault(context, def)
      }
      continue
    }

    const encoded = encodeChord(binding.chord)
    if (!encoded.ok) {
      skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
      continue
    }
    const newKeystroke = encoded.value

    if (current !== undefined) {
      if (current.keystroke === newKeystroke) continue
      removeEntry(current)
      addTo(context, newKeystroke, JSON.stringify(action))
      // Moving off the shipped default frees that slot, and a free slot is the
      // default applying again — the action would answer to both keys.
      if (def !== undefined && def !== newKeystroke) suppressDefault(context, def, current)
      continue
    }

    addTo(context, newKeystroke, JSON.stringify(action))
    if (def !== undefined && def !== newKeystroke) suppressDefault(context, def)
  }

  if (
    objOverrides.size === 0 &&
    objRemovals.size === 0 &&
    objAdditions.size === 0 &&
    newBlockAdditions.size === 0
  ) {
    return { ok: true, contents: base, skipped }
  }

  const edits: Edit[] = []

  // One edit per touched object, never one per member *and* one per object: an
  // edit nested inside another shifts the outer one's offsets as it applies,
  // and `applyEdits` splices spans rather than reconciling them.
  const touched = new Set<ObjectNode>([
    ...objOverrides.keys(),
    ...objRemovals.keys(),
    ...objAdditions.keys()
  ])
  for (const objNode of touched) {
    const removed = objRemovals.get(objNode) ?? new Set<Member>()
    const keep = objNode.members.filter((m) => !removed.has(m))
    const overrides = new Map(objOverrides.get(objNode) ?? [])
    const added: string[] = []

    for (const addition of dedupeAdditions(objAdditions.get(objNode) ?? [])) {
      // A keystroke a surviving member already holds is a rewrite of that
      // member, never a second member with the same name: duplicate keys are
      // legal JSON that silently discards the earlier binding, which here is
      // an unmanaged one belonging to the user. The last such member is the
      // one `JSON.parse` keeps, so that is the one to write through.
      let held: Member | undefined
      for (const m of keep) if (memberKeystroke(m) === addition.keystroke) held = m
      if (held !== undefined) overrides.set(held, addition.valueText)
      else added.push(renderKeystrokeMember(addition.keystroke, addition.valueText))
    }

    // An object whose membership is unchanged keeps its own formatting: splice
    // each value in place rather than reserialising the whole object.
    if (removed.size === 0 && added.length === 0) {
      for (const [m, valueText] of overrides) {
        edits.push({ start: m.value.start, end: m.value.end, text: valueText })
      }
      continue
    }

    edits.push({
      start: objNode.start,
      end: objNode.end,
      text: rewriteBindingsObject(base, objNode, keep, overrides, added, layout)
    })
  }

  if (newBlockAdditions.size > 0) {
    const blockEntries = Array.from(newBlockAdditions, ([ctx, additions]) => {
      const members = dedupeAdditions(additions).map((a) =>
        renderKeystrokeMember(a.keystroke, a.valueText)
      )
      return [ctx, members] as const
    })
    if (array === undefined) {
      const indent = rootMemberIndent(base, root, layout)
      const blocks = blockEntries.map(([ctx, added]) =>
        renderNewBlock(ctx, added, layout, indent + layout.unit)
      )
      const inner = indent + layout.unit
      const text = `${JSON.stringify('bindings')}: [${layout.newline}${inner}${blocks.join(`,${layout.newline}${inner}`)}${layout.newline}${indent}]`
      edits.push(appendInto(root, [text], { newline: layout.newline, unit: layout.unit, indent }))
    } else {
      const indent = arrayItemIndent(base, array, layout)
      const blocks = blockEntries.map(([ctx, added]) => renderNewBlock(ctx, added, layout, indent))
      edits.push(appendInto(array, blocks, { ...layout, indent }))
    }
  }

  return { ok: true, contents: applyEdits(base, edits), skipped }
}

function emptyContents(): string {
  return [
    '{',
    '  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",',
    '  "$docs": "https://code.claude.com/docs/en/keybindings",',
    '  "bindings": []',
    '}',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * "Complete" describes the curated catalogue surface unikeys actually maps —
 * five compound tokens — not Claude Code's dozens of real actions. Every one
 * of those five was sourced from the current official docs, so nothing here
 * is a guess; there is simply no claim about the actions this adapter does
 * not curate at all.
 */
const DEFAULTS_NOTE =
  "Sourced from Anthropic's official keybindings reference, current as of " +
  "Claude Code 2.1.246. Complete for unikeys' curated action set, not for every " +
  'Claude Code action.'

function defaults(app: AppId): DefaultsReport {
  if (app !== 'claude-code') {
    return {
      availability: 'unavailable',
      note: `The Claude Code adapter has no defaults for ${app}.`,
      bindings: []
    }
  }
  const bindings: ParsedBinding[] = Object.entries(CURATED_DEFAULT_CHORDS).map(([command, c]) => ({
    command,
    chord: c,
    source: 'default'
  }))
  return { availability: 'complete', note: DEFAULTS_NOTE, bindings }
}

// ---------------------------------------------------------------------------

export const claudeCodeAdapter: Adapter = {
  format: 'claude-code-keybindings',
  apps: ['claude-code'],
  parse,
  merge,
  encodeChord,
  decodeChord,
  defaults,
  emptyContents
}
