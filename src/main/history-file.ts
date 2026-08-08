/**
 * Persistence of the save log.
 *
 * A second JSON document beside the store, for the reasons set out in
 * `shared/history/types.ts`: it grows, the reducer never reads it, and a log
 * unikeys cannot parse must not be able to take the user's bindings with it.
 *
 * The entries are cached in memory once read, so the read-modify-write a save
 * performs does not re-read the file every time and two saves in flight cannot
 * interleave into a lost record.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  appendEntry,
  deserializeHistory,
  serializeHistory,
  HISTORY_SCHEMA_VERSION,
  type HistoryEntry
} from '../shared/history/types'
import { writeAtomic } from './config-files'

export interface HistoryLocation {
  historyPath: string
}

export function historyLocation(userDataDir: string): HistoryLocation {
  return { historyPath: join(userDataDir, 'unikeys-history.json') }
}

export interface LoadHistoryOutcome {
  entries: HistoryEntry[]
  /** Set when an existing log could not be read, so the page can say so. */
  error?: string
}

export function loadHistory(location: HistoryLocation): LoadHistoryOutcome {
  if (!existsSync(location.historyPath)) return { entries: [] }

  let text: string
  try {
    text = readFileSync(location.historyPath, 'utf8')
  } catch (error) {
    return { entries: [], error: `Could not read history: ${(error as Error).message}` }
  }

  const outcome = deserializeHistory(text)
  // Refusing to overwrite matches the store: a log unikeys cannot read may still
  // be one the user wants to recover by hand. New saves append to the empty list
  // and the damaged file is left where it is.
  if (!outcome.ok) return { entries: [], error: outcome.error }
  return { entries: outcome.history.entries }
}

export function saveHistory(location: HistoryLocation, entries: readonly HistoryEntry[]): void {
  mkdirSync(join(location.historyPath, '..'), { recursive: true })
  writeAtomic(
    location.historyPath,
    serializeHistory({ schemaVersion: HISTORY_SCHEMA_VERSION, entries: [...entries] })
  )
}

/** Appends, caps, persists, and hands back the capped list. */
export function recordEntry(
  location: HistoryLocation,
  entries: readonly HistoryEntry[],
  entry: HistoryEntry
): HistoryEntry[] {
  const next = appendEntry(entries, entry)
  saveHistory(location, next)
  return next
}
