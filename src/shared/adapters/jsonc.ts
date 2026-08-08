/**
 * A tolerant JSONC reader, shared by the adapters whose apps store keybindings
 * in JSON-with-comments — VSCode/Cursor's `keybindings.json`, cmux's
 * `cmux.json`, and iTerm2's dynamic profile.
 *
 * Two properties matter, and both exist because these are files the user hand
 * edits:
 *
 * - Reading is done by a small tolerant reader rather than by stripping
 *   comments with a regex, because `//` and `,` occur inside string literals
 *   (`"key": "cmd+/"`, `"when": "a && b, c"`) and a stripper would corrupt them.
 * - Every node records its **source span**, so an adapter can splice a new
 *   literal over an old one and leave the rest of the file — comments,
 *   ordering, blank lines, indentation — byte for byte as the user left it.
 *   Reserialising the parse tree would be far simpler and would silently
 *   reformat a file the user owns.
 */

export interface Span {
  start: number
  /** Exclusive, as with `String.prototype.slice`. */
  end: number
}

export interface StringNode extends Span {
  kind: 'string'
  value: string
}
export interface ScalarNode extends Span {
  kind: 'scalar'
  value: number | boolean | null
}
export interface ArrayNode extends Span {
  kind: 'array'
  items: JsoncNode[]
}
export interface ObjectNode extends Span {
  kind: 'object'
  members: Member[]
}
export interface Member extends Span {
  name: string
  value: JsoncNode
}

export type JsoncNode = StringNode | ScalarNode | ArrayNode | ObjectNode

export class JsoncError extends Error {}

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
export function readDocument(text: string): JsoncNode | null {
  const c: Cursor = { text, pos: 0 }
  skipTrivia(c)
  // A file that is empty, or only a comment header, is a file with no bindings
  // rather than a broken one.
  if (c.pos >= text.length) return null
  const value = readValue(c)
  skipTrivia(c)
  if (c.pos < text.length) {
    throw new JsoncError(`unexpected content after the root value at position ${c.pos}`)
  }
  return value
}

export function member(node: ObjectNode, name: string): Member | undefined {
  // Later members win, matching JSON.parse on duplicate keys.
  let found: Member | undefined
  for (const m of node.members) if (m.name === name) found = m
  return found
}

export function stringMember(node: ObjectNode, name: string): StringNode | undefined {
  const m = member(node, name)
  return m !== undefined && m.value.kind === 'string' ? m.value : undefined
}

/** Trimmed source of a node, for problem messages, capped so one huge entry cannot flood the UI. */
export function excerpt(text: string, node: Span): string {
  const raw = text.slice(node.start, node.end).trim()
  return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw
}

// ---------------------------------------------------------------------------
// Splicing
// ---------------------------------------------------------------------------

export interface Edit extends Span {
  text: string
}

export function applyEdits(contents: string, edits: Edit[]): string {
  // Applied back to front so earlier offsets stay valid.
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let out = contents
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

/**
 * The indentation preceding `position` on its own line, or `''` when something
 * other than whitespace precedes it — which is how a one-line entry is stopped
 * from reporting an indent it does not really have.
 */
export function indentOfLineAt(contents: string, position: number): string {
  const lineStart = contents.lastIndexOf('\n', position - 1) + 1
  const before = contents.slice(lineStart, position)
  return /^[ \t]*$/.test(before) ? before : ''
}

/**
 * The indentation of the line a node *opens* on, which is where its closing
 * bracket will land. Unlike `indentOfLineAt` this reports the leading whitespace
 * even when the node starts partway along the line: the `{` of
 * `  "Keyboard Map": {` reports two spaces, because a replacement for that
 * object has to close at the indent of `"Keyboard Map"`.
 */
export function openingIndent(contents: string, node: Span): string {
  const lineStart = contents.lastIndexOf('\n', node.start - 1) + 1
  const match = /^[ \t]*/.exec(contents.slice(lineStart, node.start))
  return match === null ? '' : match[0]
}

/** Enough of an adapter's layout to place a child; every adapter's `Layout` supplies these. */
export interface Placement {
  newline: string
  /** Indentation the children sit at. */
  indent: string
  /** One level of indentation, so an empty container knows where to close. */
  unit: string
}

/**
 * An edit appending rendered children to a container. A container that already
 * has children gains a comma and a new line after the last one; an empty one is
 * opened up rather than left as `{ "a": "b" }` on a single line.
 *
 * Shared because this is the one write every JSON adapter needs and the offsets
 * are fiddly enough to be worth getting right once: VSCode appends entries to an
 * array, cmux and iTerm2 append members to an object, and iTerm2 appends a whole
 * profile to an array.
 */
export function appendInto(
  container: ObjectNode | ArrayNode,
  rendered: string[],
  layout: Placement
): Edit {
  const children: Span[] = container.kind === 'object' ? container.members : container.items
  const body = rendered.join(`,${layout.newline}${layout.indent}`)

  const last = children[children.length - 1]
  if (last !== undefined) {
    return { start: last.end, end: last.end, text: `,${layout.newline}${layout.indent}${body}` }
  }

  const closing = container.end - 1
  const closeIndent = layout.indent.slice(0, Math.max(0, layout.indent.length - layout.unit.length))
  return {
    start: closing,
    end: closing,
    text: `${layout.newline}${layout.indent}${body}${layout.newline}${closeIndent}`
  }
}
