/**
 * Persistence of unikeys' own state.
 *
 * The store is a single JSON document in Electron's `userData` directory,
 * carrying a schema version so future migrations are possible. Backups of the
 * user's app configs live alongside it, which is what makes "where are my
 * backups" answerable with one path.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createEmptyStore,
  deserializeStore,
  serializeStore,
  type Store
} from '../shared/store/types'
import { writeAtomic } from './config-files'

export interface StoreLocation {
  storePath: string
  backupDirectory: string
}

export function storeLocation(userDataDir: string): StoreLocation {
  return {
    storePath: join(userDataDir, 'unikeys-store.json'),
    backupDirectory: join(userDataDir, 'backups')
  }
}

export interface LoadStoreOutcome {
  store: Store
  /** Set when an existing store could not be read, so the UI can say so rather
   * than silently presenting a blank slate as if it were a first run. */
  error?: string
}

export function loadStore(location: StoreLocation): LoadStoreOutcome {
  if (!existsSync(location.storePath)) {
    return { store: createEmptyStore() }
  }

  let text: string
  try {
    text = readFileSync(location.storePath, 'utf8')
  } catch (error) {
    return { store: createEmptyStore(), error: `Could not read store: ${(error as Error).message}` }
  }

  const outcome = deserializeStore(text)
  if (!outcome.ok) {
    // Refusing to overwrite is deliberate: a store unikeys cannot read may still
    // be one the user wants to recover by hand.
    return { store: createEmptyStore(), error: outcome.error }
  }
  return { store: outcome.store }
}

export function saveStore(location: StoreLocation, store: Store): void {
  mkdirSync(join(location.storePath, '..'), { recursive: true })
  writeAtomic(location.storePath, serializeStore(store))
}
