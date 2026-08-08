/**
 * The record of what each save did.
 *
 * unikeys writes to config files other programs own, so "what did I change, and
 * what was it before?" has to be answerable after the fact. `WriteResult` only
 * ever lived long enough to render a modal; this is the durable version.
 *
 * Kept in its own document with its own schema version rather than folded into
 * the store: it grows without bound, it is not state the reducer reads, and a
 * corrupt log must never be able to take the user's bindings down with it.
 */

import type { AppId } from '../apps'
import type { StoredChord } from '../store/types'
import { isSettled, type SaveOutcome } from '../table/save-outcome'

export const HISTORY_SCHEMA_VERSION = 1

/**
 * How many saves are kept. Old entries are the least useful and the log is
 * loaded whole, so it is capped rather than left to grow for the life of the
 * install.
 */
export const HISTORY_LIMIT = 200

export interface HistoryChange {
  actionId: string
  actionName: string
  app: AppId
  /**
   * What the store held before this save. **Absent** — not null — when unikeys
   * had no entry for the cell at all, which is the ordinary state of a cell the
   * user is editing for the first time. The distinction is what makes that cell
   * un-revertible: `null` is a value ("deliberately unbound") that can be
   * restored, whereas absence cannot be, since the reducer has no way to put a
   * cell back to never-seen.
   */
  previous?: StoredChord
  next: StoredChord
  outcome: SaveOutcome
}

export interface HistoryLink {
  actionId: string
  actionName: string
  linked: boolean
}

export interface HistoryApp {
  app: AppId
  name: string
  ok: boolean
  error?: string
}

export interface SaveEntry {
  kind: 'save'
  id: string
  /** Epoch milliseconds, stamped by the main process. */
  at: number
  changes: HistoryChange[]
  links: HistoryLink[]
  apps: HistoryApp[]
  /** Set when the write itself threw, so nothing can be said about disk. */
  error?: string
}

/**
 * A save that only linked or unlinked rows. It short-circuits before the write
 * path entirely, so there are no per-cell outcomes and no apps to report — which
 * is what keeps the two kinds disjoint rather than one shape with holes in it.
 */
export interface LinksOnlyEntry {
  kind: 'links-only'
  id: string
  at: number
  links: HistoryLink[]
}

export type HistoryEntry = SaveEntry | LinksOnlyEntry

/** An entry as the renderer submits it, before main stamps identity and time. */
export type NewHistoryEntry = Omit<SaveEntry, 'id' | 'at'> | Omit<LinksOnlyEntry, 'id' | 'at'>

export interface History {
  schemaVersion: number
  /** Newest first. */
  entries: HistoryEntry[]
}

export function createEmptyHistory(): History {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] }
}

/** Newest first, capped. Pure, so the cap is testable away from the filesystem. */
export function appendEntry(entries: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...entries].slice(0, HISTORY_LIMIT)
}

// ---------------------------------------------------------------------------
// What an entry can be reverted to
// ---------------------------------------------------------------------------

/**
 * Changes whose previous value can actually be restored.
 *
 * Only cells the save settled: one that never reached disk left the store
 * untouched, so "reverting" it would push a change that was never applied.
 */
export function revertibleChanges(entry: HistoryEntry): HistoryChange[] {
  if (entry.kind !== 'save') return []
  return entry.changes.filter(
    (change) => isSettled(change.outcome) && change.previous !== undefined
  )
}

/**
 * Cells this save settled that cannot be put back, because unikeys held nothing
 * for them beforehand. Counted rather than hidden — a revert that silently drops
 * some of its cells is worse than one that says how many it left alone.
 */
export function unrevertibleChanges(entry: HistoryEntry): HistoryChange[] {
  if (entry.kind !== 'save') return []
  return entry.changes.filter(
    (change) => isSettled(change.outcome) && change.previous === undefined
  )
}

/** True when there is anything at all to put back. */
export function canRevert(entry: HistoryEntry): boolean {
  return revertibleChanges(entry).length > 0 || entry.links.length > 0
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serializeHistory(history: History): string {
  return JSON.stringify(history, null, 2)
}

export type DeserializeOutcome = { ok: true; history: History } | { ok: false; error: string }

/**
 * Reads a persisted log.
 *
 * An unreadable document is refused outright, matching the store — a file
 * unikeys cannot parse may still be one the user wants to recover by hand. A
 * single malformed *entry*, though, is dropped rather than taking the rest of
 * the log with it: one lost record beats every record lost.
 */
export function deserializeHistory(text: string): DeserializeOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `History is not valid JSON: ${(error as Error).message}` }
  }
  if (!isRecord(raw)) return { ok: false, error: 'History is not an object.' }

  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version > HISTORY_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `History was written by a newer version of unikeys (schema ${version}).`
    }
  }

  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(readEntry).filter((entry): entry is HistoryEntry => entry !== null)
    : []

  return {
    ok: true,
    history: { schemaVersion: HISTORY_SCHEMA_VERSION, entries: entries.slice(0, HISTORY_LIMIT) }
  }
}

function readEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.at !== 'number') return null

  const links = Array.isArray(value.links) ? value.links.map(readLink).filter(isPresent) : []

  if (value.kind === 'links-only') {
    // An entry with nothing in it says nothing; dropping it keeps the page from
    // showing blank rows for records that lost their contents.
    if (links.length === 0) return null
    return { kind: 'links-only', id: value.id, at: value.at, links }
  }
  if (value.kind !== 'save') return null

  const changes = Array.isArray(value.changes)
    ? value.changes.map(readChange).filter(isPresent)
    : []
  const apps = Array.isArray(value.apps) ? value.apps.map(readApp).filter(isPresent) : []
  if (changes.length === 0 && links.length === 0) return null

  return {
    kind: 'save',
    id: value.id,
    at: value.at,
    changes,
    links,
    apps,
    ...(typeof value.error === 'string' ? { error: value.error } : {})
  }
}

function readChange(value: unknown): HistoryChange | null {
  if (!isRecord(value)) return null
  if (typeof value.actionId !== 'string' || typeof value.app !== 'string') return null

  const next = readChord(value.next)
  if (next === null) return null

  // `previous` is absent for a cell unikeys had never seen, and JSON drops
  // undefined properties, so an absent key is the normal case rather than a
  // sign of damage. Only a present-but-malformed value is treated as missing.
  const previous =
    value.previous === undefined ? undefined : (readChord(value.previous) ?? undefined)

  return {
    actionId: value.actionId,
    actionName: typeof value.actionName === 'string' ? value.actionName : value.actionId,
    app: value.app as AppId,
    ...(previous === undefined ? {} : { previous }),
    next,
    outcome: readOutcome(value.outcome)
  }
}

function readChord(value: unknown): StoredChord | null {
  if (!isRecord(value)) return null
  if (value.chord !== null && typeof value.chord !== 'string') return null
  const origin = value.origin
  return {
    chord: value.chord,
    origin: origin === 'default' || origin === 'imported' ? origin : 'user'
  }
}

const OUTCOMES: readonly SaveOutcome[] = [
  'written',
  'settled',
  'unsupported',
  'unreadable',
  'failed'
]

function readOutcome(value: unknown): SaveOutcome {
  // An unrecognised outcome falls back to `failed`, which is the reading that
  // cannot invent a revert: it keeps the cell out of `revertibleChanges`.
  return OUTCOMES.includes(value as SaveOutcome) ? (value as SaveOutcome) : 'failed'
}

function readLink(value: unknown): HistoryLink | null {
  if (!isRecord(value)) return null
  if (typeof value.actionId !== 'string' || typeof value.linked !== 'boolean') return null
  return {
    actionId: value.actionId,
    actionName: typeof value.actionName === 'string' ? value.actionName : value.actionId,
    linked: value.linked
  }
}

function readApp(value: unknown): HistoryApp | null {
  if (!isRecord(value)) return null
  if (typeof value.app !== 'string') return null
  return {
    app: value.app as AppId,
    name: typeof value.name === 'string' ? value.name : value.app,
    ok: value.ok === true,
    ...(typeof value.error === 'string' ? { error: value.error } : {})
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
