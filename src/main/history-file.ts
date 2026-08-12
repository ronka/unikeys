/**
 * Persistence of the save log.
 *
 * A second JSON document beside the store, for the reasons set out in
 * `shared/history/types.ts`: it grows, the reducer never reads it, and a log
 * unikeys cannot parse must not be able to take the user's bindings with it.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HistoryResult } from '../shared/ipc'
import {
  appendEntry,
  deserializeHistory,
  readEntry,
  serializeHistory,
  stampEntry,
  HISTORY_SCHEMA_VERSION,
  type HistoryEntry,
  type HistoryStamp,
  type NewHistoryEntry
} from '../shared/history/types'
import { NO_GRANTS } from '../shared/store/types'
import { writeAtomic } from './config-files'

export interface HistoryLocation {
  historyPath: string
}

export function historyLocation(userDataDir: string): HistoryLocation {
  return { historyPath: join(userDataDir, 'unikeys-history.json') }
}

export function loadHistory(location: HistoryLocation): HistoryResult {
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
    serializeHistory({ schemaVersion: HISTORY_SCHEMA_VERSION, entries: [...entries] }),
    // unikeys' own file, inside its own container: nothing to be granted.
    NO_GRANTS
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

/**
 * An open log: the file, plus the entries once they have been read.
 *
 * Appending is read-modify-write, and the cache is what saves it from re-reading
 * the whole document on every save. Encapsulated here, in the module that owns
 * the file, so the IPC layer holds one handle rather than a location, a cached
 * list, and a special case for the append that happens before any load.
 *
 * Mirrors `createBackupSession`: a small stateful handle created once per run.
 */
export interface HistoryLog {
  load(): HistoryResult
  /** Records one save and returns the log as it now stands. */
  append(entry: NewHistoryEntry, stamp: HistoryStamp): HistoryEntry[]
}

export function createHistoryLog(userDataDir: string): HistoryLog {
  const location = historyLocation(userDataDir)
  let entries: HistoryEntry[] | null = null

  const ensure = (): HistoryEntry[] => {
    if (entries === null) entries = loadHistory(location).entries
    return entries
  }

  return {
    load() {
      const outcome = loadHistory(location)
      entries = outcome.entries
      return outcome
    },

    append(entry, stamp) {
      const stamped = stampEntry(entry, stamp)
      // The entry crossed a process boundary to get here and is heading for
      // disk, so it is checked with the same reader that guards the load path.
      // Refusing it now means someone can be told; writing it would mean it
      // vanished silently at the next start.
      if (readEntry(stamped) === null) {
        throw new Error('unikeys could not make sense of what that save recorded.')
      }
      entries = recordEntry(location, ensure(), stamped)
      return entries
    }
  }
}
