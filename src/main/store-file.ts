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

import { APP_IDS, type AppId } from '../shared/apps'
import {
  createEmptyStore,
  deserializeStore,
  serializeStore,
  type Store
} from '../shared/store/types'
import { isInstalled } from './apps-service'
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

/**
 * Whether an app is installed. Injected so the seeding below is testable
 * without a real `/Applications`.
 */
export type InstallCheck = (app: AppId) => boolean

/**
 * Turns off apps the persisted store had never heard of and does not find
 * installed.
 *
 * `createEmptyStore()` enables every `APP_ID` and `deserializeStore()` starts
 * from that base, so without this a store written when unikeys knew six apps
 * comes back with thirteen columns switched on — seven of them apps the user
 * does not have, appearing with no action from them. The detection cannot live
 * in `createEmptyStore()`: that is in `src/shared/`, and `isInstalled` touches
 * the filesystem. So it happens here, once, at load.
 *
 * `known` is the set of app ids the document itself listed. An app in it is
 * already configured — the user turned it on, turned it off, or has been living
 * with the default — and is left exactly as it is whether or not it is
 * installed. Only an app the document had never heard of is seeded, and only
 * ever downwards: an installed app stays on.
 *
 * Enabling an app later still gets a populated column. Import runs on every
 * launch and writes wherever `isCellUnseen` holds, and a column that was off
 * has no entries — so the next launch after switching it on fills it in.
 */
function seedUnknownApps(store: Store, known: ReadonlySet<string>, installed: InstallCheck): Store {
  for (const app of APP_IDS) {
    if (known.has(app)) continue
    if (!installed(app)) store.apps[app] = { ...store.apps[app], enabled: false }
  }
  return store
}

/**
 * The app ids the document actually listed, which `deserializeStore` cannot
 * report because it returns a store with every app filled in. Read from the raw
 * text rather than threaded through the shared module, so nothing in
 * `src/shared/` has to learn about installation.
 */
function documentAppIds(text: string): Set<string> {
  try {
    const raw: unknown = JSON.parse(text)
    const apps = (raw as { apps?: unknown } | null)?.apps
    if (typeof apps !== 'object' || apps === null || Array.isArray(apps)) return new Set()
    return new Set(Object.keys(apps))
  } catch {
    return new Set()
  }
}

export function loadStore(
  location: StoreLocation,
  installed: InstallCheck = isInstalled
): LoadStoreOutcome {
  // A store with no document behind it knows about no apps at all, so the same
  // rule applies: a fresh install starts with the apps the machine has, not
  // with all thirteen.
  if (!existsSync(location.storePath)) {
    return { store: seedUnknownApps(createEmptyStore(), new Set(), installed) }
  }

  let text: string
  try {
    text = readFileSync(location.storePath, 'utf8')
  } catch (error) {
    return {
      store: seedUnknownApps(createEmptyStore(), new Set(), installed),
      error: `Could not read store: ${(error as Error).message}`
    }
  }

  const outcome = deserializeStore(text)
  if (!outcome.ok) {
    // Refusing to overwrite is deliberate: a store unikeys cannot read may still
    // be one the user wants to recover by hand.
    return {
      store: seedUnknownApps(createEmptyStore(), new Set(), installed),
      error: outcome.error
    }
  }
  return { store: seedUnknownApps(outcome.store, documentAppIds(text), installed) }
}

export function saveStore(location: StoreLocation, store: Store): void {
  mkdirSync(join(location.storePath, '..'), { recursive: true })
  writeAtomic(location.storePath, serializeStore(store))
}
