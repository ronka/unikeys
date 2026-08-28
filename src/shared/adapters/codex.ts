/**
 * The Codex adapter — the Codex workspace inside the ChatGPT desktop app.
 *
 * `~/.codex/keybindings.json` is a **private, undocumented format**, not a
 * published contract. Codex itself roots that path at `$CODEX_HOME` when the
 * variable is set; unikeys reads the default location only, because an
 * env-var-derived absolute path has no sandbox grant behind it — a relocated
 * `CODEX_HOME` is reached by naming the file in Apps instead. Everything
 * below was verified by statically reading the installed
 * `/Applications/ChatGPT.app/Contents/Resources/app.asar` for ChatGPT
 * `26.820.60940` — never by driving its Settings UI, which this project has no
 * way to automate, and never by runtime `.asar` extraction from unikeys itself,
 * which stays out of scope. See `__fixtures__/codex/README.md` for exactly what
 * was confirmed and how.
 *
 * The file is a JSON array of `{ command: string, key: string | null }`. Three
 * things about that shape drive every decision here:
 *
 * - Codex's own reader is a bare `JSON.parse` behind a zod schema — **strict
 *   JSON**, not JSONC. It does not tolerate comments or trailing commas. This
 *   adapter still reads through the shared tolerant `./jsonc`, matching the
 *   rest of the repository's preservation convention, but a comment unikeys
 *   preserves is one Codex itself would choke on.
 * - `key: null` is Codex's own explicit unbind. Deleting the entry instead
 *   would restore Codex's shipped default, which is the opposite of what an
 *   unbind means, so unbinding here is always a rewrite to `null`, never a
 *   deletion.
 * - A command may appear more than once; later entries are alternates. unikeys
 *   shows and rewrites only the **first** entry for a command and leaves any
 *   alternates alone, the same convention as every other adapter here.
 *
 * Codex's own writer sorts the array by command and reserialises the whole
 * file (`JSON.stringify(sorted, null, 2) + '\n'`, confirmed in the bundle).
 * unikeys deliberately does **not** reproduce that: resaving a file the user
 * hand-edited would silently reorder and reformat entries Codex itself has not
 * touched yet, which is exactly the kind of churn the rest of this codebase
 * goes out of its way to avoid. The sort/format is only used for
 * `emptyContents()`, which has no existing order to disturb.
 *
 * Legacy command ids are read into their current equivalents but only ever
 * written back as the current id, per the migration map Codex ships internally
 * (`closeTabOrWindow` fans out to two commands; the other two are 1:1). A
 * fanned-out legacy entry is never rewritten in place — it is ambiguous which
 * of the two current commands it would become — so it is left untouched as an
 * ordinary unmanaged entry and a fresh current-id entry is appended instead.
 */

import type { AppId } from '../apps'
import {
  chord,
  type Chord,
  type KeyStroke,
  type Modifier,
  normalizeModifiers,
  normalizeStroke,
  stroke
} from '../chord'
import type { ArrayNode, Edit, JsoncNode, Member, ObjectNode } from './jsonc'
import {
  appendInto,
  applyEdits,
  excerpt,
  indentOfLineAt,
  member,
  readDocument,
  stringMember
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
// Legacy command migration
// ---------------------------------------------------------------------------

/**
 * Confirmed verbatim in the bundle as
 * `{closeTabOrWindow:[closeTab,closeWindow], newThread:newTask,
 * toggleSidePanelFullWidth:toggleMaximizeSidePanel}`. A legacy id that fans out
 * to more than one current command is read as bindings for all of them, but is
 * never itself rewritten — see the module comment.
 */
const LEGACY_ALIASES: Record<string, readonly string[]> = {
  closeTabOrWindow: ['closeTab', 'closeWindow'],
  newThread: ['newTask'],
  toggleSidePanelFullWidth: ['toggleMaximizeSidePanel']
}

function currentCommandsFor(raw: string): readonly string[] {
  return LEGACY_ALIASES[raw] ?? [raw]
}

/**
 * The current id an existing entry represents for update-in-place purposes, or
 * `null` when the entry's id is an ambiguous one-to-many legacy alias that must
 * be left untouched.
 */
function resolvableCurrentCommand(raw: string): string | null {
  const aliased = LEGACY_ALIASES[raw]
  if (aliased === undefined) return raw
  return aliased.length === 1 ? aliased[0] : null
}

// ---------------------------------------------------------------------------
// Chord translation — a single Electron accelerator
// ---------------------------------------------------------------------------

/**
 * Codex's keymap holds one Electron accelerator per entry, never a chord
 * sequence — there is no such thing as a two-keystroke Codex shortcut.
 */
const ENCODE_MODIFIER_ORDER: readonly Modifier[] = ['cmd', 'ctrl', 'alt', 'shift']

const ENCODE_MODIFIER_NAMES: Record<Modifier, string> = {
  cmd: 'Cmd',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift'
}

/**
 * Accepts every modifier spelling Electron recognises, including `CmdOrCtrl` —
 * which never appears in a real file (it is a cross-platform placeholder used
 * only in Codex's own source for shipped defaults) but costs nothing to accept
 * defensively. Decoded to `cmd` on this macOS-only project, per the plan.
 */
const DECODE_MODIFIERS: Record<string, Modifier> = {
  cmd: 'cmd',
  command: 'cmd',
  cmdorctrl: 'cmd',
  commandorcontrol: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
}

/**
 * Electron's documented accelerator key names. Letters, digits and the
 * punctuation already in `CANONICAL_KEYS` are written literally and need no
 * table; only the named keys need spelling out, and Electron accepts both
 * `Return` and `Enter` for the same key.
 */
const ENCODE_KEYS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]))
}

const DECODE_KEYS: ReadonlyMap<string, string> = new Map([
  ...Object.entries(ENCODE_KEYS).map(
    ([canonical, electron]) => [electron.toLowerCase(), canonical] as const
  ),
  ['return', 'enter']
])

function encodeKey(key: string): string | null {
  const named = ENCODE_KEYS[key]
  if (named !== undefined) return named
  if (key.length === 1) return key.toUpperCase()
  return null
}

function decodeKey(text: string): string | null {
  const named = DECODE_KEYS.get(text.toLowerCase())
  if (named !== undefined) return named
  if (text.length === 1) {
    const lower = text.toLowerCase()
    return CANONICAL_KEY_SET.has(lower) ? lower : null
  }
  return null
}

// Only letters, digits and the punctuation Electron writes literally reach
// `decodeKey`'s single-character branch; anything else must be a named key.
const CANONICAL_KEY_SET = new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
  '-',
  '=',
  '[',
  ']',
  '\\',
  ';',
  "'",
  ',',
  '.',
  '/',
  '`'
])

function encodeChord(c: Chord): EncodeOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'the chord has no keystrokes' }
  if (c.strokes.length > 1) {
    return {
      ok: false,
      reason: 'a Codex keyboard shortcut is a single Electron accelerator, not a chord sequence'
    }
  }

  const s = normalizeStroke(c.strokes[0])
  const key = encodeKey(s.key)
  if (key === null) return { ok: false, reason: `Codex has no key named "${s.key}"` }

  const held = new Set(normalizeModifiers(s.modifiers))
  const parts = ENCODE_MODIFIER_ORDER.filter((m) => held.has(m)).map(
    (m) => ENCODE_MODIFIER_NAMES[m]
  )
  return { ok: true, value: [...parts, key].join('+') }
}

function decodeChord(text: string): Chord | null {
  const tokens = text.trim().split('+')
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
  const s: KeyStroke = { modifiers: normalizeModifiers(modifiers), key }
  return { strokes: [s] }
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
  if (root.kind !== 'array') {
    return { ok: false, error: 'keybindings.json must contain an array of keybindings' }
  }

  const bindings: ParsedBinding[] = []
  const problems: ParseProblem[] = []
  const seen = new Set<string>()

  for (const item of root.items) {
    if (item.kind !== 'object') {
      problems.push({ message: 'entry is not an object', detail: excerpt(contents, item) })
      continue
    }

    const commandNode = stringMember(item, 'command')
    if (commandNode === undefined || commandNode.value.trim() === '') {
      problems.push({ message: 'entry has no "command"', detail: excerpt(contents, item) })
      continue
    }
    const rawCommand = commandNode.value.trim()

    const keyEntry = member(item, 'key')
    if (keyEntry === undefined) {
      problems.push({
        message: `entry for "${rawCommand}" has no "key"`,
        detail: excerpt(contents, item)
      })
      continue
    }

    let chordValue: Chord | null
    if (keyEntry.value.kind === 'scalar' && keyEntry.value.value === null) {
      chordValue = null
    } else if (keyEntry.value.kind === 'string') {
      const decoded = decodeChord(keyEntry.value.value)
      if (decoded === null) {
        problems.push({
          message: `could not read the shortcut "${keyEntry.value.value}" for "${rawCommand}"`,
          detail: excerpt(contents, item)
        })
        continue
      }
      chordValue = decoded
    } else {
      problems.push({
        message: `entry for "${rawCommand}" has a "key" that is not a string or null`,
        detail: excerpt(contents, item)
      })
      continue
    }

    for (const command of currentCommandsFor(rawCommand)) {
      // Only the first entry for a command is managed; later ones are the
      // user's alternates and are neither shown nor rewritten.
      if (seen.has(command)) continue
      seen.add(command)
      const binding: ParsedBinding = { command, chord: chordValue, source: 'user' }
      if (chordValue === null) binding.negated = true
      bindings.push(binding)
    }
  }

  return { ok: true, bindings, problems }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

interface Entry {
  node: ObjectNode
  rawCommand: string
  resolvedCommand: string | null
  commandValue: Member
  keyValue: Member | undefined
}

interface Layout {
  newline: string
  unit: string
  itemIndent: string
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
    if (observed.length > itemIndent.length) memberIndent = observed
  }

  return { newline, unit, itemIndent, memberIndent }
}

function collectEntries(root: ArrayNode): Entry[] {
  const entries: Entry[] = []
  for (const item of root.items) {
    if (item.kind !== 'object') continue
    const commandValue = member(item, 'command')
    if (commandValue === undefined || commandValue.value.kind !== 'string') continue
    const raw = commandValue.value.value.trim()
    if (raw === '') continue
    entries.push({
      node: item,
      rawCommand: raw,
      resolvedCommand: resolvableCurrentCommand(raw),
      commandValue,
      keyValue: member(item, 'key')
    })
  }
  return entries
}

function renderEntry(command: string, key: string | null, layout: Layout): string {
  const keyText = key === null ? 'null' : JSON.stringify(key)
  return [
    '{',
    `${layout.memberIndent}${JSON.stringify('command')}: ${JSON.stringify(command)},`,
    `${layout.memberIndent}${JSON.stringify('key')}: ${keyText}`,
    `${layout.itemIndent}}`
  ].join(layout.newline)
}

/**
 * The entry that decides what `command` is currently bound to: the first one
 * in file order naming it, whether under its current id or a legacy alias.
 * This is the same "first entry wins" rule `parse` reads by, so what merge
 * rewrites is always what the table showed.
 *
 * When that entry is an ambiguous one-to-many alias (`closeTabOrWindow`
 * shadowing `closeTab`) it cannot be rewritten in place — which of the two
 * current commands it would become is unknowable — so it is left alone and a
 * fresh entry goes in *front* of it. Appending instead would put the new entry
 * after the alias, where "first entry wins" discards it and the save silently
 * does nothing. A later explicit entry for the command is shadowed the same
 * way, so it is not a rewrite target either.
 */
function decidingEntry(entries: readonly Entry[], command: string): Entry | undefined {
  return entries.find((e) => currentCommandsFor(e.rawCommand).includes(command))
}

function prependEntries(root: ArrayNode, rendered: string[], layout: Layout): Edit {
  const body = rendered.join(`,${layout.newline}${layout.itemIndent}`)
  const first = root.items[0]
  // Only ever called when an ambiguous alias entry already exists, so the
  // array is never empty here.
  return {
    start: first.start,
    end: first.start,
    text: `${body},${layout.newline}${layout.itemIndent}`
  }
}

function isNullKey(keyValue: Member | undefined): boolean {
  return keyValue !== undefined && keyValue.value.kind === 'scalar' && keyValue.value.value === null
}

function currentKeyChord(keyValue: Member | undefined): Chord | null | undefined {
  if (keyValue === undefined) return undefined
  if (keyValue.value.kind === 'scalar' && keyValue.value.value === null) return null
  if (keyValue.value.kind === 'string') return decodeChord(keyValue.value.value) ?? undefined
  return undefined
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
  const prepended: string[] = []
  const skipped: InexpressibleChord[] = []

  for (const binding of managed) {
    const deciding = decidingEntry(entries, binding.command)
    // An ambiguous alias is never rewritten in place, so from here it counts as
    // "no entry of mine" — with `shadowed` recording that a new one has to go
    // in front of it rather than at the end.
    const shadowed = deciding !== undefined && deciding.resolvedCommand !== binding.command
    const first = shadowed ? undefined : deciding

    if (binding.chord === null) {
      if (first === undefined) {
        // The alias already unbinds it; a second entry in front would say the
        // same thing twice.
        if (shadowed && isNullKey(deciding?.keyValue)) continue
        const rendered = renderEntry(binding.command, null, layout)
        if (shadowed) prepended.push(rendered)
        else appended.push(rendered)
        continue
      }
      if (isNullKey(first.keyValue) && first.rawCommand === binding.command) continue
      if (first.keyValue === undefined) {
        edits.push({
          start: first.node.start,
          end: first.node.end,
          text: renderEntry(binding.command, null, layout)
        })
      } else {
        edits.push({
          start: first.keyValue.value.start,
          end: first.keyValue.value.end,
          text: 'null'
        })
        if (first.rawCommand !== binding.command) {
          edits.push({
            start: first.commandValue.value.start,
            end: first.commandValue.value.end,
            text: JSON.stringify(binding.command)
          })
        }
      }
      continue
    }

    const encoded = encodeChord(binding.chord)
    if (!encoded.ok) {
      skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
      continue
    }

    if (first === undefined) {
      // The alias already binds it to exactly this chord; re-stating it in
      // front would grow the file on every save and change nothing.
      const aliased = currentKeyChord(deciding?.keyValue)
      const aliasMatches =
        aliased !== undefined && aliased !== null && chordsEqualOrNull(aliased, binding.chord)
      if (shadowed && aliasMatches) continue
      const rendered = renderEntry(binding.command, encoded.value, layout)
      if (shadowed) prepended.push(rendered)
      else appended.push(rendered)
      continue
    }

    const already = currentKeyChord(first.keyValue)
    const matches =
      already !== undefined && already !== null && chordsEqualOrNull(already, binding.chord)
    if (matches && first.rawCommand === binding.command) continue

    if (first.keyValue === undefined) {
      edits.push({
        start: first.node.start,
        end: first.node.end,
        text: renderEntry(binding.command, encoded.value, layout)
      })
    } else {
      edits.push({
        start: first.keyValue.value.start,
        end: first.keyValue.value.end,
        text: JSON.stringify(encoded.value)
      })
      if (first.rawCommand !== binding.command) {
        edits.push({
          start: first.commandValue.value.start,
          end: first.commandValue.value.end,
          text: JSON.stringify(binding.command)
        })
      }
    }
  }

  if (appended.length > 0) {
    edits.push(appendInto(root, appended, { ...layout, indent: layout.itemIndent }))
  }
  if (prepended.length > 0) {
    edits.push(prependEntries(root, prepended, layout))
  }
  return { ok: true, contents: applyEdits(base, edits), skipped }
}

function chordsEqualOrNull(a: Chord, b: Chord): boolean {
  if (a.strokes.length !== b.strokes.length) return false
  return a.strokes.every((s, i) => {
    const other = b.strokes[i]
    const na = normalizeStroke(s)
    const nb = normalizeStroke(other)
    return (
      na.key === nb.key &&
      na.modifiers.length === nb.modifiers.length &&
      na.modifiers.every((m, j) => m === nb.modifiers[j])
    )
  })
}

function emptyContents(): string {
  return '[]\n'
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * Every command id here was found verbatim in the app's command registry and
 * its default Electron accelerator confirmed in the same bundle — see
 * `__fixtures__/codex/README.md` for the exact evidence and OpenAI's public
 * Commands reference, which independently corroborates every one of these.
 *
 * Deliberately not exhaustive: Codex's registry has around 120 commands, and
 * curating a default here is a promise about that command's shortcut, not just
 * its existence. `composer.submit` is a real, configurable command id with no
 * entry below because it ships with no default Electron accelerator at all —
 * Enter-to-send is handled outside this file.
 */
export const CODEX_COMMAND_IDS: ReadonlySet<string> = new Set([
  'newTask',
  'composer.submit',
  'composer.openModelPicker',
  'closeTab',
  'nextTab',
  'previousTab',
  'toggleTerminal'
])

const CURATED_DEFAULTS: Record<string, Chord> = {
  newTask: chord(stroke('n', 'cmd')),
  closeTab: chord(stroke('w', 'cmd')),
  'composer.openModelPicker': chord(stroke('m', 'ctrl', 'shift')),
  nextTab: chord(stroke(']', 'cmd', 'shift')),
  previousTab: chord(stroke('[', 'cmd', 'shift')),
  toggleTerminal: chord(stroke('`', 'ctrl'))
}

const DEFAULTS_NOTE =
  "Codex's keybindings.json is a private, undocumented format, verified against " +
  'ChatGPT desktop 26.820.60940. Only the command ids and default shortcuts confirmed ' +
  "against that build are curated here — a future ChatGPT update can change Codex's " +
  'command registry without notice, and commands outside this curated set show no default.'

function defaults(app: AppId): DefaultsReport {
  if (app !== 'codex') {
    return {
      availability: 'unavailable',
      note: `The Codex adapter has no defaults for ${app}.`,
      bindings: []
    }
  }
  const bindings: ParsedBinding[] = Object.entries(CURATED_DEFAULTS).map(([command, c]) => ({
    command,
    chord: c,
    source: 'default'
  }))
  return { availability: 'partial', note: DEFAULTS_NOTE, bindings }
}

// ---------------------------------------------------------------------------

export const codexAdapter: Adapter = {
  format: 'codex-keybindings',
  apps: ['codex'],
  parse,
  merge,
  encodeChord,
  decodeChord,
  defaults,
  emptyContents
}
