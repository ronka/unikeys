/**
 * The cmux adapter.
 *
 * `~/.config/cmux/cmux.json` is JSONC, and cmux writes it itself on first
 * launch as a template: two real members (`$schema`, `schemaVersion`) followed
 * by a couple of hundred lines of commented-out settings the user is invited to
 * uncomment. Preserving those comments is the whole point of the file, so
 * merging splices over recorded spans exactly as the VSCode adapter does and
 * never reserialises.
 *
 * Bindings live at `shortcuts.bindings`, keyed by cmux action id. The schema
 * calls them *overrides*: an absent key means "cmux's own default applies".
 * That makes this adapter markedly simpler than the other three —
 *
 * - unbinding writes the empty-string sentinel and stops. There is no
 *   `-command` negation to append (VSCode) and no default trigger to name
 *   (Ghostty), because nothing here suppresses defaults wholesale;
 * - `defaultsSuppressed` is never set, for the same reason.
 *
 * Notation comes from cmux's published JSON Schema rather than observation.
 * Two consequences worth stating up front: cmux has no spelling at all for
 * Escape, Backspace, Delete, Insert, Home, End, Page Up or Page Down, and a
 * first keystroke must carry a modifier unless its key is Space. Both are
 * reported as inexpressible rather than written as something cmux would reject.
 */

import type { AppId } from '../apps'
import type { Chord, KeyStroke, Modifier } from '../chord'
import { MAX_STROKES, canonicalKey, canonicalModifier, normalizeModifiers } from '../chord'
import type { Edit, JsoncNode, Member, ObjectNode } from './jsonc'
import {
  appendInto,
  applyEdits,
  excerpt,
  indentOfLineAt,
  member,
  openingIndent,
  readDocument
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

const SCHEMA_URL =
  'https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json'

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

/**
 * Every action id cmux's schema accepts under `shortcuts.bindings`
 * (`propertyNames.enum`, cmux 0.64.22). The object is `additionalProperties:
 * false`, so writing an id that is not here would make cmux reject the file —
 * and an unrecognised id found while reading is a problem to surface, not a
 * binding to show.
 */
export const CMUX_ACTION_IDS: ReadonlySet<string> = new Set([
  'openSettings',
  'reloadConfiguration',
  'showHideAllWindows',
  'globalSearch',
  'newWindow',
  'closeWindow',
  'toggleFullScreen',
  'quit',
  'toggleSidebar',
  'newTab',
  'newBrowserWorkspace',
  'openFolder',
  'reopenPreviousSession',
  'goToWorkspace',
  'commandPalette',
  'commandPaletteNext',
  'commandPalettePrevious',
  'sendFeedback',
  'showNotifications',
  'jumpToUnread',
  'toggleUnread',
  'markOldestUnreadAndJumpNext',
  'focusRightSidebar',
  'switchRightSidebarToFiles',
  'switchRightSidebarToFind',
  'switchRightSidebarToSessions',
  'switchRightSidebarToFeed',
  'switchRightSidebarToDock',
  'triggerFlash',
  'nextSurface',
  'prevSurface',
  'moveSurfaceLeft',
  'moveSurfaceRight',
  'moveSurfaceToPreviousPane',
  'moveSurfaceToNextPane',
  'moveSurfaceToPaneLeft',
  'moveSurfaceToPaneRight',
  'moveSurfaceToPaneUp',
  'moveSurfaceToPaneDown',
  'selectSurfaceByNumber',
  'nextSidebarTab',
  'prevSidebarTab',
  'moveWorkspaceUp',
  'moveWorkspaceDown',
  'focusHistoryBack',
  'focusHistoryForward',
  'selectWorkspaceByNumber',
  'renameTab',
  'renameWorkspace',
  'editWorkspaceDescription',
  'markWorkspaceDone',
  'cycleWorkspaceStatus',
  'toggleChecklistItemComplete',
  'closeTab',
  'closeOtherTabsInPane',
  'closeWorkspace',
  'newWorkspaceGroup',
  'groupSelectedWorkspaces',
  'toggleFocusedWorkspaceGroupCollapsed',
  'reopenClosedWorkspace',
  'reopenClosedBrowserPanel',
  'newSurface',
  'toggleTerminalCopyMode',
  'focusTextBoxInput',
  'cycleTextBoxSubmitAction',
  'attachTextBoxFile',
  'sendCtrlFToTerminal',
  'clearScreenKeepScrollback',
  'simulatorHome',
  'simulatorRotateLeft',
  'simulatorRotateRight',
  'simulatorToggleAppearance',
  'simulatorToggleSoftwareKeyboard',
  'focusLeft',
  'focusRight',
  'focusUp',
  'focusDown',
  'focusPreviousPane',
  'focusNextPane',
  'splitRight',
  'splitDown',
  'toggleSplitZoom',
  'increaseWorkspaceTerminalFontSize',
  'decreaseWorkspaceTerminalFontSize',
  'resetWorkspaceTerminalFontSize',
  'equalizeSplits',
  'splitBrowserRight',
  'splitBrowserDown',
  'toggleCanvasLayout',
  'canvasRevealFocusedPane',
  'canvasOverview',
  'canvasZoomIn',
  'canvasZoomOut',
  'canvasZoomReset',
  'canvasTidy',
  'canvasAlignLeft',
  'canvasAlignRight',
  'canvasAlignTop',
  'canvasAlignBottom',
  'canvasEqualizeWidths',
  'canvasEqualizeHeights',
  'canvasDistributeHorizontally',
  'canvasDistributeVertically',
  'toggleFileExplorer',
  'fileExplorerOpenSelection',
  'fileExplorerOpenSelectionFinderAlias',
  'saveFilePreview',
  'openBrowser',
  'focusBrowserAddressBar',
  'browserBack',
  'browserForward',
  'browserReload',
  'browserHardReload',
  'browserZoomIn',
  'browserZoomOut',
  'browserZoomReset',
  'markdownZoomIn',
  'markdownZoomOut',
  'markdownZoomReset',
  'find',
  'findInDirectory',
  'findNext',
  'findPrevious',
  'hideFind',
  'useSelectionForFind',
  'toggleBrowserDeveloperTools',
  'showBrowserJavaScriptConsole',
  'toggleBrowserFocusMode',
  'toggleBrowserDesignMode',
  'toggleReactGrab',
  'openDiffViewer',
  'diffViewerScrollDown',
  'diffViewerScrollUp',
  'diffViewerScrollHalfPageDown',
  'diffViewerScrollHalfPageUp',
  'diffViewerScrollDownEmacs',
  'diffViewerScrollUpEmacs',
  'diffViewerScrollToBottom',
  'diffViewerScrollToTop',
  'diffViewerOpenFileSearch',
  'diffViewerNextFile',
  'diffViewerPreviousFile'
])

/**
 * The values cmux reads as "this action has no shortcut". Written out in full
 * because a config may already contain any of them, though unikeys only ever
 * writes the first.
 */
const UNBIND_SENTINELS: ReadonlySet<string> = new Set(['', 'none', 'clear', 'unbound', 'disabled'])

const UNBIND_VALUE = ''

function isUnbindSentinel(text: string): boolean {
  return UNBIND_SENTINELS.has(text.trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// Chord translation
// ---------------------------------------------------------------------------

/**
 * cmux's parser accepts modifiers in any order, so the order here is chosen for
 * what the user will read in their own file: the one cmux's generated template
 * uses, which leads with `cmd` (`cmd+shift+p`, `cmd+ctrl+u`).
 */
const ENCODE_MODIFIER_ORDER: readonly Modifier[] = ['cmd', 'ctrl', 'alt', 'shift']

/** cmux spells Option `opt`; the other three match canonical names. */
const MODIFIER_NAMES: Record<Modifier, string> = {
  cmd: 'cmd',
  ctrl: 'ctrl',
  alt: 'opt',
  shift: 'shift'
}

/**
 * Canonical keys cmux spells differently. Letters, digits, the eleven
 * punctuation keys and f1–f20 are written literally, which is why they are
 * absent here.
 */
const KEY_NAMES: Record<string, string> = {
  enter: 'return',
  space: 'space',
  tab: 'tab',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right'
}

/**
 * Canonical keys cmux's grammar has no spelling for at all. Encoding one is a
 * reportable failure rather than a guess: cmux would reject the file.
 */
const UNSUPPORTED_KEYS: ReadonlySet<string> = new Set([
  'escape',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown'
])

/**
 * cmux spellings the shared canonical vocabulary does not already accept. The
 * arrow and return symbols matter because cmux's own generated template writes
 * them; `\r` matters because that template writes a raw carriage return for
 * Return even though the schema says `return`.
 */
const DECODE_KEY_ALIASES: Record<string, string> = {
  '←': 'left',
  '→': 'right',
  '↑': 'up',
  '↓': 'down',
  leftarrow: 'left',
  rightarrow: 'right',
  uparrow: 'up',
  downarrow: 'down',
  '↩': 'enter',
  '\r': 'enter',
  '<space>': 'space',
  leftbracket: '[',
  openbracket: '[',
  rightbracket: ']',
  closebracket: ']',
  hyphen: '-'
}

/** cmux accepts `ctl`; every other modifier spelling is already canonical. */
const DECODE_MODIFIER_ALIASES: Record<string, Modifier> = { ctl: 'ctrl' }

function encodeStroke(s: KeyStroke, isFirst: boolean): EncodeOutcome {
  const key = canonicalKey(s.key)
  if (key === null) return { ok: false, reason: `unknown key "${s.key}"` }
  if (UNSUPPORTED_KEYS.has(key)) return { ok: false, reason: `cmux has no ${key} key` }

  const modifiers = normalizeModifiers(s.modifiers)
  // cmux requires the first keystroke to be modified, so a plain letter cannot
  // start a shortcut. Space is the schema's one exception.
  if (isFirst && modifiers.length === 0 && key !== 'space') {
    return { ok: false, reason: 'cmux needs a modifier on the first keystroke' }
  }

  const present = new Set(modifiers)
  const parts = ENCODE_MODIFIER_ORDER.filter((m) => present.has(m)).map((m) => MODIFIER_NAMES[m])
  parts.push(KEY_NAMES[key] ?? key)
  return { ok: true, value: parts.join('+') }
}

function encodeChord(c: Chord): EncodeOutcome {
  if (c.strokes.length === 0) return { ok: false, reason: 'chord has no keystrokes' }
  if (c.strokes.length > MAX_STROKES) {
    return { ok: false, reason: `cmux supports at most ${MAX_STROKES} keystrokes` }
  }
  const parts: string[] = []
  for (const [index, s] of c.strokes.entries()) {
    const encoded = encodeStroke(s, index === 0)
    if (!encoded.ok) return encoded
    parts.push(encoded.value)
  }
  return { ok: true, value: parts.join(' ') }
}

/**
 * Splits a chord's keystrokes. cmux separates them by writing an array, so this
 * only has to handle the space-separated form unikeys' own text entry produces.
 *
 * The split is on a space that *precedes another keystroke*, not on whitespace
 * generally, and nothing is trimmed. Both matter: the schema permits a bare
 * literal space as the key (`" "`, `"cmd+ "`), and cmux's own template writes a
 * raw carriage return for Return — trimming would silently drop either one.
 */
function splitStrokes(text: string): string[] {
  if (text === '') return []
  return text.split(/ (?=\S)/)
}

function decodeChord(text: string): Chord | null {
  return decodeStrokes(splitStrokes(text))
}

function decodeStrokes(parts: readonly string[]): Chord | null {
  if (parts.length === 0 || parts.length > MAX_STROKES) return null
  const strokes: KeyStroke[] = []
  for (const part of parts) {
    const decoded = decodeStroke(part)
    if (decoded === null) return null
    strokes.push(decoded)
  }
  return { strokes }
}

function decodeStroke(text: string): KeyStroke | null {
  const tokens = tokenizeStroke(text)
  if (tokens.length === 0) return null

  const modifiers: Modifier[] = []
  let key: string | null = null

  for (const token of tokens) {
    const mod = decodeModifier(token)
    if (mod !== null) {
      // A modifier after the base key is malformed.
      if (key !== null) return null
      modifiers.push(mod)
      continue
    }
    if (key !== null) return null
    key = decodeKey(token)
    if (key === null) return null
  }

  if (key === null) return null
  return { modifiers: normalizeModifiers(modifiers), key }
}

function decodeModifier(token: string): Modifier | null {
  const lower = token.trim().toLowerCase()
  return DECODE_MODIFIER_ALIASES[lower] ?? canonicalModifier(lower)
}

function decodeKey(token: string): string | null {
  // Aliases are looked up untrimmed, because `\r` is one of them and trimming
  // would turn cmux's own spelling of Return into an empty token.
  const aliased = DECODE_KEY_ALIASES[token.toLowerCase()]
  if (aliased !== undefined) return aliased
  // A run of literal spaces is the schema's bare-space key, reachable both as
  // `" "` on its own and as the tail of `"cmd+ "`.
  if (/^ +$/.test(token)) return 'space'
  return canonicalKey(token.trim().toLowerCase())
}

/**
 * Splits `cmd+shift+p` into tokens. `+` separates only when something precedes
 * it, so `cmd+-` keeps its punctuation base key and `cmd++` reads as the plus
 * key. `-` is never a separator in cmux notation.
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
// Parsing
// ---------------------------------------------------------------------------

/** The `shortcuts.bindings` object, when the file has one. */
function bindingsObject(root: JsoncNode | null): ObjectNode | null {
  if (root === null || root.kind !== 'object') return null
  const shortcuts = member(root, 'shortcuts')
  if (shortcuts === undefined || shortcuts.value.kind !== 'object') return null
  const bindings = member(shortcuts.value, 'bindings')
  if (bindings === undefined || bindings.value.kind !== 'object') return null
  return bindings.value
}

function parse(contents: string): ParseOutcome {
  let root: JsoncNode | null
  try {
    root = readDocument(contents)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `cmux.json is not valid JSON: ${message}` }
  }

  if (root !== null && root.kind !== 'object') {
    return { ok: false, error: 'cmux.json must contain an object' }
  }

  const bindings = bindingsObject(root)
  // A config with no `shortcuts.bindings` — cmux's freshly generated template
  // is exactly this — is a config that overrides nothing, not a broken one.
  if (bindings === null) return { ok: true, bindings: [], problems: [] }

  const parsed: ParsedBinding[] = []
  const problems: ParseProblem[] = []

  for (const entry of bindings.members) {
    const command = entry.name
    if (!CMUX_ACTION_IDS.has(command)) {
      problems.push({
        message: `"${command}" is not a cmux action id`,
        detail: excerpt(contents, entry)
      })
      continue
    }

    const value = entry.value

    // An explicit `null`, like the string sentinels, is a deliberate unbind.
    if (value.kind === 'scalar' && value.value === null) {
      parsed.push({ command, chord: null, source: 'user', negated: true })
      continue
    }

    if (value.kind === 'string') {
      if (isUnbindSentinel(value.value)) {
        parsed.push({ command, chord: null, source: 'user', negated: true })
        continue
      }
      const chord = decodeChord(value.value)
      if (chord === null) {
        problems.push({
          message: `cannot read the shortcut for "${command}"`,
          detail: excerpt(contents, entry)
        })
        continue
      }
      parsed.push({ command, chord, source: 'user' })
      continue
    }

    if (value.kind === 'array') {
      const strokes: string[] = []
      let readable = value.items.length > 0 && value.items.length <= MAX_STROKES
      for (const item of value.items) {
        if (item.kind !== 'string') {
          readable = false
          break
        }
        strokes.push(item.value)
      }
      const chord = readable ? decodeStrokes(strokes) : null
      if (chord === null) {
        problems.push({
          message: `cannot read the chorded shortcut for "${command}"`,
          detail: excerpt(contents, entry)
        })
        continue
      }
      parsed.push({ command, chord, source: 'user' })
      continue
    }

    problems.push({
      message: `the shortcut for "${command}" is neither a string nor an array`,
      detail: excerpt(contents, entry)
    })
  }

  // No `defaultsSuppressed`: `bindings` overrides cmux's defaults one action at
  // a time and never discards them wholesale.
  return { ok: true, bindings: parsed, problems }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

interface Layout {
  newline: string
  /** One level of indentation, e.g. two spaces. */
  unit: string
}

function detectLayout(contents: string): Layout {
  return {
    newline: contents.includes('\r\n') ? '\r\n' : '\n',
    unit: /^\t/m.test(contents) ? '\t' : '  '
  }
}

/** Indentation the members of `node` sit at, inferred from the first of them. */
function memberIndent(contents: string, node: ObjectNode, fallback: string): string {
  const first = node.members[0]
  if (first === undefined) return fallback
  const observed = indentOfLineAt(contents, first.start)
  return observed === '' ? fallback : observed
}

function renderBinding(command: string, value: string): string {
  return `${JSON.stringify(command)}: ${JSON.stringify(value)}`
}

/** Wraps rendered bindings in the object levels a file is missing. */
function renderNested(
  names: readonly string[],
  bindings: readonly string[],
  layout: Layout,
  indent: string
): string {
  const [head, ...rest] = names
  const inner = indent + layout.unit
  const body =
    rest.length === 0
      ? bindings.join(`,${layout.newline}${inner}`)
      : renderNested(rest, bindings, layout, inner)
  return `${JSON.stringify(head)}: {${layout.newline}${inner}${body}${layout.newline}${indent}}`
}

function merge(contents: string, managed: ManagedBinding[]): MergeOutcome {
  const base = contents.trim() === '' ? emptyContents() : contents

  let root: JsoncNode | null
  try {
    root = readDocument(base)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `refusing to write: cmux.json is not valid JSON: ${message}` }
  }
  if (root === null || root.kind !== 'object') {
    return { ok: false, error: 'refusing to write: cmux.json must contain an object' }
  }

  const layout = detectLayout(base)
  const edits: Edit[] = []
  const skipped: InexpressibleChord[] = []
  /** `command -> value`, for bindings the file has no member for yet. */
  const added: Array<[string, string]> = []

  const shortcuts = member(root, 'shortcuts')
  const shortcutsObject =
    shortcuts !== undefined && shortcuts.value.kind === 'object' ? shortcuts.value : null
  const bindings = bindingsObject(root)

  for (const binding of managed) {
    if (!CMUX_ACTION_IDS.has(binding.command)) {
      if (binding.chord !== null) {
        skipped.push({
          command: binding.command,
          chord: binding.chord,
          reason: `"${binding.command}" is not a cmux action id`
        })
      }
      continue
    }

    let value: string
    if (binding.chord === null) {
      // `bindings` layers over cmux's defaults, so the sentinel is the whole
      // story — there is no shipped default left to negate separately.
      value = UNBIND_VALUE
    } else {
      const encoded = encodeChord(binding.chord)
      if (!encoded.ok) {
        skipped.push({ command: binding.command, chord: binding.chord, reason: encoded.reason })
        continue
      }
      value = encoded.value
    }

    const existing: Member | undefined =
      bindings === null ? undefined : member(bindings, binding.command)

    if (existing === undefined) {
      added.push([binding.command, value])
      continue
    }
    // Comparing decoded values, not source text, keeps an already-correct entry
    // byte-identical whatever escaping the user wrote it with.
    if (existing.value.kind === 'string' && existing.value.value === value) continue
    edits.push({
      start: existing.value.start,
      end: existing.value.end,
      text: JSON.stringify(value)
    })
  }

  if (added.length > 0) {
    const rendered = added.map(([command, value]) => renderBinding(command, value))

    if (bindings !== null) {
      const indent = memberIndent(base, bindings, openingIndent(base, bindings) + layout.unit)
      edits.push(appendInto(bindings, rendered, { ...layout, indent }))
    } else if (shortcutsObject !== null) {
      // `shortcuts` exists but has no `bindings` yet.
      const indent = memberIndent(
        base,
        shortcutsObject,
        openingIndent(base, shortcutsObject) + layout.unit
      )
      edits.push(
        appendInto(shortcutsObject, [renderNested(['bindings'], rendered, layout, indent)], {
          ...layout,
          indent
        })
      )
    } else {
      // Neither level exists. This is the case cmux's generated template hits:
      // its `$schema` and `schemaVersion` members are real and everything else
      // is a comment, so the root is a populated object with no `shortcuts`.
      const indent = memberIndent(base, root, layout.unit)
      edits.push(
        appendInto(root, [renderNested(['shortcuts', 'bindings'], rendered, layout, indent)], {
          ...layout,
          indent
        })
      )
    }
  }

  return { ok: true, contents: applyEdits(base, edits), skipped }
}

function emptyContents(): string {
  return [
    '{',
    `  "$schema": ${JSON.stringify(SCHEMA_URL)},`,
    '  "schemaVersion": 1,',
    '  "shortcuts": {',
    '    "bindings": {}',
    '  }',
    '}',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * cmux's default shortcuts, transcribed from the commented-out template cmux
 * 0.64.22 generates at `~/.config/cmux/cmux.json`.
 *
 * The template prints 69 of the schema's 142 action ids, so an id missing from
 * this table means "the template did not list it", not "cmux leaves it
 * unbound". Notation is the template's own, which is why arrows appear as
 * symbols and Return as a raw carriage return.
 *
 * `selectSurfaceByNumber` and `selectWorkspaceByNumber` are number-key
 * *families* in cmux — the `1` stands for 1 through 9 — so the chord recorded
 * here is the family's first member rather than the whole binding.
 */
const DEFAULT_SHORTCUTS: Record<string, string> = {
  attachTextBoxFile: 'cmd+shift+opt+a',
  browserBack: 'cmd+[',
  browserForward: 'cmd+]',
  browserReload: 'cmd+r',
  browserZoomIn: 'cmd+=',
  browserZoomOut: 'cmd+-',
  browserZoomReset: 'cmd+0',
  closeOtherTabsInPane: 'cmd+opt+t',
  closeTab: 'cmd+w',
  closeWindow: 'cmd+ctrl+w',
  closeWorkspace: 'cmd+shift+w',
  commandPalette: 'cmd+shift+p',
  commandPaletteNext: 'ctrl+n',
  commandPalettePrevious: 'ctrl+p',
  editWorkspaceDescription: 'cmd+opt+e',
  equalizeSplits: 'cmd+ctrl+=',
  find: 'cmd+f',
  findInDirectory: 'cmd+shift+f',
  findNext: 'cmd+g',
  findPrevious: 'cmd+opt+g',
  focusBrowserAddressBar: 'cmd+l',
  focusDown: 'cmd+opt+↓',
  focusLeft: 'cmd+opt+←',
  focusRight: 'cmd+opt+→',
  focusRightSidebar: 'cmd+shift+e',
  focusTextBoxInput: 'cmd+shift+a',
  focusUp: 'cmd+opt+↑',
  globalSearch: 'cmd+opt+f',
  goToWorkspace: 'cmd+p',
  hideFind: 'cmd+shift+opt+f',
  jumpToUnread: 'cmd+shift+u',
  markOldestUnreadAndJumpNext: 'cmd+ctrl+u',
  newSurface: 'cmd+t',
  newTab: 'cmd+n',
  newWindow: 'cmd+shift+n',
  nextSidebarTab: 'cmd+ctrl+]',
  nextSurface: 'cmd+shift+]',
  openBrowser: 'cmd+shift+l',
  openFolder: 'cmd+o',
  openSettings: 'cmd+,',
  prevSidebarTab: 'cmd+ctrl+[',
  prevSurface: 'cmd+shift+[',
  quit: 'cmd+q',
  reloadConfiguration: 'cmd+shift+,',
  renameTab: 'cmd+r',
  renameWorkspace: 'cmd+shift+r',
  reopenClosedBrowserPanel: 'cmd+shift+t',
  reopenPreviousSession: 'cmd+shift+o',
  saveFilePreview: 'cmd+s',
  selectSurfaceByNumber: 'ctrl+1',
  selectWorkspaceByNumber: 'cmd+1',
  sendFeedback: '',
  showBrowserJavaScriptConsole: 'cmd+opt+c',
  showHideAllWindows: 'cmd+opt+ctrl+.',
  showNotifications: 'cmd+i',
  splitBrowserDown: 'cmd+shift+opt+d',
  splitBrowserRight: 'cmd+opt+d',
  splitDown: 'cmd+shift+d',
  splitRight: 'cmd+d',
  toggleBrowserDeveloperTools: 'cmd+opt+i',
  toggleFileExplorer: 'cmd+opt+b',
  toggleFullScreen: 'cmd+ctrl+f',
  toggleReactGrab: 'cmd+shift+g',
  toggleSidebar: 'cmd+b',
  toggleSplitZoom: 'cmd+shift+\r',
  toggleTerminalCopyMode: 'cmd+shift+m',
  toggleUnread: 'cmd+opt+u',
  triggerFlash: 'cmd+shift+h',
  useSelectionForFind: 'cmd+e'
}

const DEFAULTS_NOTE =
  'Defaults captured from the config template cmux 0.64.22 generates, which lists 69 of the ' +
  '142 actions cmux accepts. cmux Settings > Keyboard Shortcuts is authoritative.'

// ---------------------------------------------------------------------------

export const cmuxAdapter: Adapter = {
  format: 'cmux-config',
  apps: ['cmux'],

  parse,
  merge,
  encodeChord,

  decodeChord(text: string): Chord | null {
    return decodeChord(text)
  },

  defaults(app: AppId): DefaultsReport {
    if (app !== 'cmux') {
      return {
        availability: 'unavailable',
        note: `The cmux adapter has no defaults for ${app}.`,
        bindings: []
      }
    }
    const bindings: ParsedBinding[] = []
    for (const [command, text] of Object.entries(DEFAULT_SHORTCUTS)) {
      // The template ships at least one unbound default (`sendFeedback`), so
      // the sentinel check has to run here too rather than assuming a chord.
      if (isUnbindSentinel(text)) {
        bindings.push({ command, chord: null, source: 'default', negated: true })
        continue
      }
      const chord = decodeChord(text)
      if (chord !== null) bindings.push({ command, chord, source: 'default' })
    }
    return { availability: 'partial', note: DEFAULTS_NOTE, bindings }
  },

  emptyContents
}
