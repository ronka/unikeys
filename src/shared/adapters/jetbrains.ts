/**
 * The JetBrains keymap adapter, shared by WebStorm, IntelliJ IDEA and PyCharm.
 *
 * The IDEs are one product built on the IntelliJ platform, and the keymap is a
 * platform file: same XML, same inheritance chain, same action ids for
 * everything unikeys manages. Nothing below is specialised per IDE, which is
 * why the adapter names them collectively rather than singling one out.
 *
 * A JetBrains keymap is an XML document whose `<action>` elements carry
 * `<keyboard-shortcut>` children, and which usually names a `parent` keymap it
 * inherits from. Three properties of that format drive nearly every decision
 * here:
 *
 * 1. **A keymap is a diff, not a whole configuration.** Almost every binding
 *    the user actually has lives in an ancestor keymap. Reading a single file
 *    therefore answers "what did the user change", never "what is bound"; the
 *    second question needs `resolveInheritance`. Writing has the mirror
 *    obligation: an override must be written as an override — one `<action>`
 *    element — and the `parent` attribute must survive untouched.
 *
 * 2. **An empty `<action>` element means "unbound", not "unspecified".** It is
 *    how the format suppresses an inherited binding, so it is also how unikeys
 *    writes a managed binding with no chord. Deleting the element would restore
 *    the inherited chord, which is the opposite of what the user asked for.
 *
 * 3. **The file is the user's, and most of it is none of our business.** Merges
 *    are textual splices over spans located by the scanner below, never a
 *    parse-and-reserialise. Reserialising would silently normalise attribute
 *    order, quoting, comments and indentation across a file unikeys only has
 *    permission to change a handful of elements in.
 */

import type { AppId } from '../apps'
import type { Chord, KeyStroke, Modifier } from '../chord'
import {
  MAX_STROKES,
  normalizeStroke,
  canonicalKey,
  canonicalModifier,
  parseCanonical
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
// Key vocabulary
// ---------------------------------------------------------------------------

/**
 * Canonical key -> the `java.awt.event.KeyEvent` name JetBrains writes. The
 * awkward spellings (`BACK_SPACE`, `OPEN_BRACKET`) are Java's, not ours, and
 * are the only ones a JetBrains IDE will read back.
 */
const CANONICAL_TO_JETBRAINS: Record<string, string> = {
  enter: 'ENTER',
  escape: 'ESCAPE',
  tab: 'TAB',
  space: 'SPACE',
  backspace: 'BACK_SPACE',
  delete: 'DELETE',
  insert: 'INSERT',
  home: 'HOME',
  end: 'END',
  pageup: 'PAGE_UP',
  pagedown: 'PAGE_DOWN',
  up: 'UP',
  down: 'DOWN',
  left: 'LEFT',
  right: 'RIGHT',
  '-': 'MINUS',
  '=': 'EQUALS',
  '[': 'OPEN_BRACKET',
  ']': 'CLOSE_BRACKET',
  '\\': 'BACK_SLASH',
  ';': 'SEMICOLON',
  "'": 'QUOTE',
  ',': 'COMMA',
  '.': 'PERIOD',
  '/': 'SLASH',
  '`': 'BACK_QUOTE'
}

for (const letter of 'abcdefghijklmnopqrstuvwxyz')
  CANONICAL_TO_JETBRAINS[letter] = letter.toUpperCase()
for (const digit of '0123456789') CANONICAL_TO_JETBRAINS[digit] = digit
// Java defines VK_F1 through VK_F24; the canonical vocabulary stops at 20.
for (let n = 1; n <= 20; n++) CANONICAL_TO_JETBRAINS[`f${n}`] = `F${n}`

const JETBRAINS_TO_CANONICAL: Record<string, string> = {}
for (const [canonical, jetbrains] of Object.entries(CANONICAL_TO_JETBRAINS)) {
  JETBRAINS_TO_CANONICAL[jetbrains] = canonical
}

/**
 * Modifiers are emitted in `java.awt.AWTKeyStroke.toString()` order, which is
 * what produced every keymap the IDEs ship. Decoding accepts any order, since
 * a hand-edited keymap is under no such obligation.
 */
const JETBRAINS_MODIFIER_ORDER: readonly Modifier[] = ['shift', 'ctrl', 'cmd', 'alt']

const MODIFIER_TO_JETBRAINS: Record<Modifier, string> = {
  shift: 'shift',
  ctrl: 'ctrl',
  cmd: 'meta',
  alt: 'alt'
}

/**
 * Separates the two keystrokes of a chord in `encodeChord`/`decodeChord`.
 *
 * The format itself has no single-string notation for a two-keystroke chord —
 * it uses two separate attributes — so this notation is unikeys' own and is
 * never written to a file. `merge` encodes each keystroke individually.
 */
const STROKE_SEPARATOR = ', '

function encodeKeystroke(raw: KeyStroke): EncodeOutcome {
  const s = normalizeStroke(raw)
  const key = CANONICAL_TO_JETBRAINS[s.key]
  if (!key) return { ok: false, reason: `JetBrains keymaps have no key name for "${s.key}"` }
  const mods = JETBRAINS_MODIFIER_ORDER.filter((m) => s.modifiers.includes(m)).map(
    (m) => MODIFIER_TO_JETBRAINS[m]
  )
  return { ok: true, value: [...mods, key].join(' ') }
}

function decodeKeystroke(text: string): KeyStroke | null {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '')
  if (tokens.length === 0) return null

  const modifiers: Modifier[] = []
  let key: string | null = null

  for (const token of tokens) {
    const mod = canonicalModifier(token)
    if (mod) {
      // A modifier after the base key is malformed rather than merely unusual.
      if (key !== null) return null
      modifiers.push(mod)
      continue
    }
    if (key !== null) return null
    key = JETBRAINS_TO_CANONICAL[token.toUpperCase()] ?? canonicalKey(token)
    if (key === null) return null
  }

  if (key === null) return null
  return normalizeStroke({ modifiers, key })
}

export function encodeChord(chord: Chord): EncodeOutcome {
  if (chord.strokes.length === 0)
    return { ok: false, reason: 'A chord needs at least one keystroke' }
  if (chord.strokes.length > MAX_STROKES) {
    return { ok: false, reason: 'JetBrains IDEs support at most two keystrokes in a shortcut' }
  }
  const parts: string[] = []
  for (const s of chord.strokes) {
    const encoded = encodeKeystroke(s)
    if (!encoded.ok) return encoded
    parts.push(encoded.value)
  }
  return { ok: true, value: parts.join(STROKE_SEPARATOR) }
}

export function decodeChord(text: string): Chord | null {
  const strokeTexts = text.split(',')
  if (strokeTexts.length === 0 || strokeTexts.length > MAX_STROKES) return null
  const strokes: KeyStroke[] = []
  for (const strokeText of strokeTexts) {
    const s = decodeKeystroke(strokeText)
    if (!s) return null
    strokes.push(s)
  }
  return { strokes }
}

// ---------------------------------------------------------------------------
// A minimal XML scanner
// ---------------------------------------------------------------------------

/**
 * Elements are recorded as *spans into the source*, never as data to be written
 * back out. Everything the merge does is a splice at one of these offsets, so
 * whitespace, attribute quoting, comments and element ordering outside the
 * spliced span cannot be disturbed.
 */
interface XmlElement {
  name: string
  attrs: Record<string, string>
  /** Index of the opening `<`. */
  start: number
  /** Index just past the element (past `/>` or past `</name>`). */
  end: number
  /** Index just past the open tag's `>`. Equals `end` when self-closing. */
  innerStart: number
  /** Index of the closing tag's `<`. Equals `innerStart` when self-closing. */
  innerEnd: number
  selfClosing: boolean
  children: XmlElement[]
}

class XmlError extends Error {}

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_.\-:]/

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/** Parses a whole document and returns its root element. Throws `XmlError`. */
function parseDocument(src: string): XmlElement {
  let i = skipMisc(src, 0)
  if (i >= src.length || src[i] !== '<') throw new XmlError('No root element found')
  const [root, end] = parseElement(src, i)
  i = skipMisc(src, end)
  if (i < src.length) throw new XmlError('Unexpected content after the root element')
  return root
}

/** Skips whitespace, comments, the XML declaration, doctypes and PIs. */
function skipMisc(src: string, from: number): number {
  let i = from
  for (;;) {
    while (i < src.length && isSpace(src[i])) i++
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      if (end === -1) throw new XmlError('Unterminated comment')
      i = end + 3
      continue
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2)
      if (end === -1) throw new XmlError('Unterminated processing instruction')
      i = end + 2
      continue
    }
    if (src.startsWith('<!', i)) {
      const end = src.indexOf('>', i + 2)
      if (end === -1) throw new XmlError('Unterminated declaration')
      i = end + 1
      continue
    }
    return i
  }
}

function readName(src: string, from: number): [string, number] {
  let i = from
  if (i >= src.length || !NAME_START.test(src[i])) throw new XmlError('Expected an element name')
  while (i < src.length && NAME_CHAR.test(src[i])) i++
  return [src.slice(from, i), i]
}

/** Parses one element starting at `src[from] === '<'`. Returns it and its end. */
function parseElement(src: string, from: number): [XmlElement, number] {
  const [name, afterName] = readName(src, from + 1)
  let i = afterName
  const attrs: Record<string, string> = {}

  for (;;) {
    while (i < src.length && isSpace(src[i])) i++
    if (i >= src.length) throw new XmlError(`Unterminated <${name}> tag`)
    if (src.startsWith('/>', i)) {
      const end = i + 2
      return [
        {
          name,
          attrs,
          start: from,
          end,
          innerStart: end,
          innerEnd: end,
          selfClosing: true,
          children: []
        },
        end
      ]
    }
    if (src[i] === '>') {
      i++
      break
    }
    const [attrName, afterAttrName] = readName(src, i)
    i = afterAttrName
    while (i < src.length && isSpace(src[i])) i++
    if (src[i] !== '=') throw new XmlError(`Malformed attribute "${attrName}" on <${name}>`)
    i++
    while (i < src.length && isSpace(src[i])) i++
    const quote = src[i]
    if (quote !== '"' && quote !== "'")
      throw new XmlError(`Unquoted attribute "${attrName}" on <${name}>`)
    const close = src.indexOf(quote, i + 1)
    if (close === -1) throw new XmlError(`Unterminated attribute "${attrName}" on <${name}>`)
    attrs[attrName] = decodeEntities(src.slice(i + 1, close))
    i = close + 1
  }

  const innerStart = i
  const children: XmlElement[] = []

  for (;;) {
    const next = src.indexOf('<', i)
    if (next === -1) throw new XmlError(`Unclosed <${name}> element`)
    if (src.startsWith('<!--', next)) {
      const end = src.indexOf('-->', next + 4)
      if (end === -1) throw new XmlError('Unterminated comment')
      i = end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', next)) {
      const end = src.indexOf(']]>', next + 9)
      if (end === -1) throw new XmlError('Unterminated CDATA section')
      i = end + 3
      continue
    }
    if (src.startsWith('<?', next)) {
      const end = src.indexOf('?>', next + 2)
      if (end === -1) throw new XmlError('Unterminated processing instruction')
      i = end + 2
      continue
    }
    if (src.startsWith('</', next)) {
      const [closeName, afterCloseName] = readName(src, next + 2)
      if (closeName !== name) throw new XmlError(`Expected </${name}> but found </${closeName}>`)
      let j = afterCloseName
      while (j < src.length && isSpace(src[j])) j++
      if (src[j] !== '>') throw new XmlError(`Malformed </${name}> tag`)
      const end = j + 1
      return [
        { name, attrs, start: from, end, innerStart, innerEnd: next, selfClosing: false, children },
        end
      ]
    }
    const [child, childEnd] = parseElement(src, next)
    children.push(child)
    i = childEnd
  }
}

// ---------------------------------------------------------------------------
// Parsing a keymap
// ---------------------------------------------------------------------------

/**
 * One parsed keymap file.
 *
 * `removed` sits alongside `bindings` because within a single file a removal is
 * a statement *about* inheritance rather than a binding of its own, and
 * `resolveInheritance` is the only thing that can act on it. It is re-expressed
 * as a chordless negated `ParsedBinding` at the `Adapter.parse` boundary, where
 * the caller has no inheritance chain and needs to know the cell is unbound
 * rather than unmentioned.
 */
export interface Keymap {
  name: string
  /** The keymap this one inherits from, or `null` for a root keymap. */
  parent: string | null
  /** Bindings this file states itself. */
  bindings: ParsedBinding[]
  /** Command ids whose inherited binding this file explicitly removes. */
  removed: string[]
  problems: ParseProblem[]
}

export type KeymapOutcome = ({ ok: true } & Keymap) | { ok: false; error: string }

export function parseKeymap(contents: string): KeymapOutcome {
  let root: XmlElement
  try {
    root = parseDocument(contents)
  } catch (error) {
    const message = error instanceof XmlError ? error.message : 'Could not read the keymap XML'
    return { ok: false, error: message }
  }

  if (root.name !== 'keymap') {
    return { ok: false, error: `Expected a <keymap> root element but found <${root.name}>` }
  }

  const bindings: ParsedBinding[] = []
  const removed: string[] = []
  const problems: ParseProblem[] = []

  for (const action of root.children) {
    if (action.name !== 'action') continue
    const command = action.attrs.id
    if (!command) {
      problems.push({ message: 'An <action> element has no id and was ignored' })
      continue
    }

    const shortcuts = action.children.filter((c) => c.name === 'keyboard-shortcut')
    if (shortcuts.length === 0) {
      // Present-but-empty is the format's way of saying "inherit nothing here".
      // Mouse shortcuts do not count as a keyboard binding, so an action with
      // only a <mouse-shortcut> still suppresses the inherited keystroke.
      removed.push(command)
      continue
    }

    // Only the first shortcut becomes the binding unikeys shows; the rest are
    // alternates it preserves but does not display or manage.
    const shortcut = shortcuts[0]
    const first = shortcut.attrs['first-keystroke']
    const second = shortcut.attrs['second-keystroke']
    if (!first) {
      problems.push({
        message: `The shortcut for "${command}" has no first-keystroke`,
        detail: contents.slice(shortcut.start, shortcut.end)
      })
      continue
    }

    const firstStroke = decodeKeystroke(first)
    if (!firstStroke) {
      problems.push({ message: `Could not read the shortcut for "${command}"`, detail: first })
      continue
    }
    const strokes = [firstStroke]
    if (second !== undefined) {
      const secondStroke = decodeKeystroke(second)
      if (!secondStroke) {
        problems.push({ message: `Could not read the shortcut for "${command}"`, detail: second })
        continue
      }
      strokes.push(secondStroke)
    }

    bindings.push({ command, chord: { strokes }, source: 'user' })
  }

  return {
    ok: true,
    name: root.attrs.name ?? '',
    parent: root.attrs.parent ?? null,
    bindings,
    removed,
    problems
  }
}

/**
 * Flattens an inheritance chain into what is actually bound.
 *
 * `ancestors` are already-parsed keymaps, nearest-first — the caller owns
 * loading them, because following `parent` means touching the filesystem and
 * adapters never do. Nearer keymaps win, the child wins over all of them, and a
 * removal anywhere in the chain suppresses everything above it.
 */
export function resolveInheritance(child: Keymap, ancestors: readonly Keymap[]): ParsedBinding[] {
  const resolved = new Map<string, ParsedBinding>()

  // Furthest ancestor first, so nearer layers overwrite what they inherit.
  for (const ancestor of [...ancestors].reverse()) {
    for (const command of ancestor.removed) resolved.delete(command)
    // Anything the user did not state in the child file reads as a default,
    // whichever ancestor it came from.
    for (const binding of ancestor.bindings)
      resolved.set(binding.command, { ...binding, source: 'default' })
  }

  // A removal in the child is the user's decision, so it stays visible as an
  // explicit unbind rather than vanishing into "never mentioned".
  for (const command of child.removed) {
    if (resolved.delete(command)) {
      resolved.set(command, { command, chord: null, source: 'user', negated: true })
    }
  }
  for (const binding of child.bindings)
    resolved.set(binding.command, { ...binding, source: 'user' })

  return [...resolved.values()]
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

interface Edit {
  start: number
  end: number
  text: string
}

function applyEdits(src: string, edits: Edit[]): string {
  // Applied back-to-front so earlier offsets stay valid.
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let out = src
  for (const edit of ordered) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

/** The whitespace run before `index`, when nothing else precedes it on the line. */
function indentBefore(src: string, index: number): string {
  let i = index
  while (i > 0 && (src[i - 1] === ' ' || src[i - 1] === '\t')) i--
  if (i === 0 || src[i - 1] === '\n') return src.slice(i, index)
  return ''
}

interface Layout {
  lineEnd: string
  actionIndent: string
  childIndent: string
  /** One level of indentation, for nesting under an action at any depth. */
  unit: string
}

/**
 * Infers indentation from what the document already does, so an inserted
 * element is indistinguishable from a hand-written one. Falls back to two
 * spaces only when there is nothing to copy.
 */
function inferLayout(src: string, root: XmlElement): Layout {
  const lineEnd = src.includes('\r\n') ? '\r\n' : '\n'
  const firstAction = root.children.find((c) => c.name === 'action')
  const actionIndent = firstAction ? indentBefore(src, firstAction.start) || '  ' : '  '

  let childIndent = ''
  for (const action of root.children) {
    const child = action.children[0]
    if (child) {
      childIndent = indentBefore(src, child.start)
      if (childIndent) break
    }
  }
  if (!childIndent) childIndent = actionIndent + (actionIndent || '  ')
  const unit = childIndent.startsWith(actionIndent) ? childIndent.slice(actionIndent.length) : '  '
  return { lineEnd, actionIndent, childIndent, unit: unit || '  ' }
}

function shortcutElement(chord: Chord): EncodeOutcome {
  const strokes: string[] = []
  for (const s of chord.strokes) {
    const encoded = encodeKeystroke(s)
    if (!encoded.ok) return encoded
    strokes.push(encoded.value)
  }
  if (strokes.length === 0 || strokes.length > MAX_STROKES) {
    return { ok: false, reason: 'JetBrains IDEs support one or two keystrokes in a shortcut' }
  }
  const second = strokes[1] ? ` second-keystroke="${escapeAttribute(strokes[1])}"` : ''
  return {
    ok: true,
    value: `<keyboard-shortcut first-keystroke="${escapeAttribute(strokes[0])}"${second} />`
  }
}

/** `<action id="X"` … rewritten as a self-closing tag, keeping its attributes. */
function selfClosingForm(src: string, action: XmlElement): string {
  const openTag = src.slice(action.start, action.selfClosing ? action.end : action.innerStart)
  const withoutClose = action.selfClosing ? openTag.slice(0, -2) : openTag.slice(0, -1)
  return `${withoutClose.trimEnd()} />`
}

function openForm(src: string, action: XmlElement): string {
  const openTag = src.slice(action.start, action.selfClosing ? action.end : action.innerStart)
  const withoutClose = action.selfClosing ? openTag.slice(0, -2) : openTag.slice(0, -1)
  return `${withoutClose.trimEnd()}>`
}

/**
 * True when the action holds anything besides whitespace and keyboard
 * shortcuts — a comment or a `<mouse-shortcut>`. Such an action can never be
 * collapsed to a self-closing tag, because that would delete content unikeys
 * does not own.
 */
function hasUnmanagedContent(src: string, action: XmlElement, shortcuts: XmlElement[]): boolean {
  if (action.selfClosing) return false
  let inner = src.slice(action.innerStart, action.innerEnd)
  for (const shortcut of shortcuts) {
    const from = shortcut.start - action.innerStart
    const to = shortcut.end - action.innerStart
    inner = inner.slice(0, from) + ' '.repeat(to - from) + inner.slice(to)
  }
  return inner.trim() !== ''
}

/** Deletes an element and, when it sits alone on its line, that line's break. */
function deletionEdit(src: string, element: XmlElement): Edit {
  const indent = indentBefore(src, element.start)
  let start = element.start - indent.length
  if (start > 0 && src[start - 1] === '\n') {
    start -= 1
    if (start > 0 && src[start - 1] === '\r') start -= 1
  }
  return { start, end: element.end, text: '' }
}

export function mergeKeymap(contents: string, managed: ManagedBinding[]): MergeOutcome {
  let root: XmlElement
  try {
    root = parseDocument(contents)
  } catch (error) {
    const message = error instanceof XmlError ? error.message : 'Could not read the keymap XML'
    return { ok: false, error: message }
  }
  if (root.name !== 'keymap') {
    return { ok: false, error: `Expected a <keymap> root element but found <${root.name}>` }
  }

  // A later entry for the same command supersedes an earlier one; two edits to
  // one element would otherwise overlap.
  const wanted = new Map<string, ManagedBinding>()
  for (const binding of managed) wanted.set(binding.command, binding)

  const layout = inferLayout(contents, root)
  const byId = new Map<string, XmlElement>()
  for (const child of root.children) {
    if (child.name !== 'action') continue
    const id = child.attrs.id
    // First occurrence wins, matching how the platform reads a duplicated id.
    if (id && !byId.has(id)) byId.set(id, child)
  }

  const edits: Edit[] = []
  const skipped: InexpressibleChord[] = []
  const appended: string[] = []

  for (const binding of wanted.values()) {
    let element: string | null = null
    if (binding.chord !== null) {
      const encoded = shortcutElement(binding.chord)
      if (!encoded.ok) {
        skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
        continue
      }
      element = encoded.value
    }

    const action = byId.get(binding.command)
    if (!action) {
      // Absent actions are appended rather than replacing the keymap, so the
      // parent attribute and every existing override stay exactly as they were.
      appended.push(
        element === null
          ? `${layout.actionIndent}<action id="${escapeAttribute(binding.command)}" />`
          : `${layout.actionIndent}<action id="${escapeAttribute(binding.command)}">${layout.lineEnd}` +
              `${layout.childIndent}${element}${layout.lineEnd}` +
              `${layout.actionIndent}</action>`
      )
      continue
    }

    const shortcuts = action.children.filter((c) => c.name === 'keyboard-shortcut')

    if (element === null) {
      // Unbinding: every keyboard shortcut goes, and the element stays behind to
      // suppress the inherited binding.
      if (shortcuts.length === 0) continue
      if (hasUnmanagedContent(contents, action, shortcuts)) {
        for (const shortcut of shortcuts) edits.push(deletionEdit(contents, shortcut))
      } else {
        edits.push({
          start: action.start,
          end: action.end,
          text: selfClosingForm(contents, action)
        })
      }
      continue
    }

    if (shortcuts.length > 0) {
      // Replacing only the first shortcut leaves any alternates the user added
      // untouched.
      const target = shortcuts[0]
      if (contents.slice(target.start, target.end) !== element) {
        edits.push({ start: target.start, end: target.end, text: element })
      }
      continue
    }

    if (action.selfClosing || action.children.length === 0) {
      const indent = indentBefore(contents, action.start) || layout.actionIndent
      const childIndent = indent + layout.unit
      edits.push({
        start: action.start,
        end: action.end,
        text:
          `${openForm(contents, action)}${layout.lineEnd}` +
          `${childIndent}${element}${layout.lineEnd}` +
          `${indent}</action>`
      })
      continue
    }

    // The action has content but no keyboard shortcut — a mouse shortcut or a
    // comment. Slot the new shortcut in ahead of it.
    const first = action.children[0]
    const indent = indentBefore(contents, first.start)
    edits.push({
      start: first.start,
      end: first.start,
      text: `${element}${layout.lineEnd}${indent}`
    })
  }

  if (appended.length > 0) {
    if (root.selfClosing) {
      // A `<keymap ... />` with no body still has to become a container.
      const body = appended.map((a) => `${layout.lineEnd}${a}`).join('')
      edits.push({
        start: root.start,
        end: root.end,
        text: `${openForm(contents, root)}${body}${layout.lineEnd}</keymap>`
      })
    } else {
      const closeIndent = indentBefore(contents, root.innerEnd)
      const at = root.innerEnd - closeIndent.length
      const needsBreak = at > 0 && contents[at - 1] !== '\n'
      const text =
        (needsBreak ? layout.lineEnd : '') +
        appended.map((a) => `${a}${layout.lineEnd}`).join('') +
        closeIndent
      edits.push({ start: at, end: at, text })
    }
  }

  return { ok: true, contents: applyEdits(contents, edits), skipped }
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * A curated slice of the macOS keymap, shared by every IDE this adapter serves.
 *
 * The real defaults live inside each application bundle as keymap XML with its
 * own inheritance chain, so they are only readable on a machine with that IDE
 * installed. Rather than leave the column empty on first run, unikeys ships the
 * bindings that are stable across recent releases and reports the partial
 * coverage instead of implying the list is complete.
 *
 * One table covers WebStorm, IntelliJ IDEA and PyCharm by decision, not by
 * oversight: every id below — `SaveAll`, `GotoFile`, `$Undo`,
 * `CommentByLineComment` and the rest — is a platform-level action that the
 * IntelliJ platform itself defines and binds identically in the macOS keymap it
 * ships to all of its IDEs. Nothing here is language- or framework-specific, so
 * per-IDE tables would be three copies of one list. An action that genuinely
 * differed between IDEs would not belong in this table at all.
 */
const MACOS_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['SaveAll', 'cmd+s'],
  ['GotoFile', 'cmd+shift+o'],
  ['GotoClass', 'cmd+o'],
  ['GotoSymbol', 'alt+cmd+o'],
  ['GotoAction', 'cmd+shift+a'],
  ['GotoLine', 'cmd+l'],
  ['RecentFiles', 'cmd+e'],
  ['Find', 'cmd+f'],
  ['FindNext', 'cmd+g'],
  ['FindPrevious', 'cmd+shift+g'],
  ['Replace', 'cmd+r'],
  ['FindInPath', 'cmd+shift+f'],
  ['ReplaceInPath', 'cmd+shift+r'],
  ['FindUsages', 'alt+f7'],
  ['ShowUsages', 'alt+cmd+f7'],
  ['CommentByLineComment', 'cmd+/'],
  ['CommentByBlockComment', 'alt+cmd+/'],
  ['ReformatCode', 'alt+cmd+l'],
  ['OptimizeImports', 'ctrl+alt+o'],
  ['GotoDeclaration', 'cmd+b'],
  ['GotoImplementation', 'alt+cmd+b'],
  ['Back', 'alt+cmd+left'],
  ['Forward', 'alt+cmd+right'],
  ['RenameElement', 'shift+f6'],
  ['ExtractMethod', 'alt+cmd+m'],
  ['IntroduceVariable', 'alt+cmd+v'],
  ['Refactorings.QuickListPopupAction', 'ctrl+t'],
  ['Run', 'ctrl+r'],
  ['Debug', 'ctrl+d'],
  ['Stop', 'cmd+f2'],
  ['ActivateTerminalToolWindow', 'alt+f12'],
  ['ActivateProjectToolWindow', 'cmd+1'],
  ['ActivateVersionControlToolWindow', 'cmd+9'],
  // Splitter navigation is the only pane movement the macOS keymap binds;
  // SplitVertically / SplitHorizontally ship no shortcut at all.
  ['NextSplitter', 'alt+tab'],
  ['PrevSplitter', 'alt+shift+tab'],
  ['NextTab', 'cmd+shift+]'],
  ['PreviousTab', 'cmd+shift+['],
  ['CloseContent', 'cmd+w'],
  ['EditorSelectWord', 'alt+up'],
  ['EditorUnSelectWord', 'alt+down'],
  ['EditorDuplicate', 'cmd+d'],
  ['EditorDeleteLine', 'cmd+backspace'],
  ['MoveLineUp', 'alt+shift+up'],
  ['MoveLineDown', 'alt+shift+down'],
  ['ShowIntentionActions', 'alt+enter'],
  ['CodeCompletion', 'ctrl+space'],
  ['SmartTypeCompletion', 'ctrl+shift+space'],
  ['ParameterInfo', 'cmd+p'],
  ['QuickJavaDoc', 'ctrl+j'],
  ['Generate', 'cmd+n'],
  ['$Undo', 'cmd+z'],
  ['$Redo', 'cmd+shift+z'],
  ['$SelectAll', 'cmd+a']
]

const DEFAULTS_NOTE =
  'JetBrains IDEs ship their keymaps inside the application bundle rather than as a ' +
  'readable config file, so unikeys cannot read them. These are a curated subset of the ' +
  'macOS keymap; actions outside it will show as unbound unless you have overridden them.'

function macosDefaults(): ParsedBinding[] {
  const bindings: ParsedBinding[] = []
  for (const [command, text] of MACOS_DEFAULTS) {
    const chord = parseCanonical(text)
    // Unreachable for the table above; skipping beats shipping a broken chord.
    if (chord) bindings.push({ command, chord, source: 'default' })
  }
  return bindings
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The IDEs this adapter serves, in `APP_IDS` order.
 *
 * One list feeds both `apps` and the `defaults` gate, so the set the registry
 * advertises and the set `defaults` will answer for cannot drift apart.
 */
const JETBRAINS_APPS = ['webstorm', 'intellij', 'pycharm'] as const satisfies readonly AppId[]

function servesApp(app: AppId): boolean {
  return (JETBRAINS_APPS as readonly AppId[]).includes(app)
}

export const jetbrainsAdapter: Adapter = {
  format: 'jetbrains-keymap',
  apps: JETBRAINS_APPS,

  /**
   * Parses one keymap file in isolation, which is all the interface's string
   * contract allows. The result is the user's own overrides; inherited bindings
   * need `parseKeymap` plus `resolveInheritance`, which the caller reaches for
   * once it has loaded the ancestor files.
   */
  parse(contents: string): ParseOutcome {
    const outcome = parseKeymap(contents)
    if (!outcome.ok) return { ok: false, error: outcome.error }
    // Removals are surfaced as chordless negated bindings so a consumer holding
    // only the `Adapter` interface can tell "the user unbound this" from "the
    // user never mentioned it" — otherwise the cell would show the inherited
    // default the user deliberately removed.
    const removals: ParsedBinding[] = outcome.removed.map((command) => ({
      command,
      chord: null,
      source: 'user',
      negated: true
    }))
    return { ok: true, bindings: [...outcome.bindings, ...removals], problems: outcome.problems }
  },

  merge: mergeKeymap,
  encodeChord,
  decodeChord,

  /**
   * The same curated macOS keymap for every IDE this adapter serves — see
   * `MACOS_DEFAULTS` for why one table is right. Anything else still gets
   * `unavailable`: the adapter is reachable by format, and answering for an app
   * it does not serve would put JetBrains action ids in someone else's column.
   */
  defaults(app: AppId): DefaultsReport {
    if (!servesApp(app)) {
      return {
        availability: 'unavailable',
        note: `The JetBrains adapter has no defaults for ${app}.`,
        bindings: []
      }
    }
    return { availability: 'partial', note: DEFAULTS_NOTE, bindings: macosDefaults() }
  },

  /**
   * A fresh keymap must still declare a parent, or the IDE would treat it as a
   * keymap in which nothing at all is bound. `Mac OS X 10.5+` is the macOS
   * keymap the IntelliJ platform ships under that name in all three IDEs.
   */
  emptyContents(): string {
    return '<keymap version="1" name="unikeys" parent="Mac OS X 10.5+">\n</keymap>\n'
  }
}
