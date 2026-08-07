/**
 * unikeys' own persisted state.
 *
 * unikeys is the source of truth: it maintains its own store of chords, linked
 * state and app configuration, and apps are write targets. There is no two-way
 * sync and no drift detection.
 *
 * Chords are held here in canonical string form (see `formatCanonical`), never
 * in any app's notation — notation is an adapter concern.
 */

import { APP_IDS, type AppId } from '../apps'

export const STORE_SCHEMA_VERSION = 1

/**
 * Where a cell's chord came from. Distinguishing these is what lets the user
 * see why their apps diverged in the first place.
 */
export type ChordOrigin =
  /** Imported from the app's shipped defaults — the user never touched it. */
  | 'default'
  /** Imported from the user's own config file — their existing customisation. */
  | 'imported'
  /** Set by the user inside unikeys. */
  | 'user'

export interface StoredChord {
  /** Canonical chord string, or `null` for "deliberately not bound". */
  chord: string | null
  origin: ChordOrigin
}

export interface AppConfig {
  enabled: boolean
  /**
   * A path the user set by hand when auto-detection failed. `null` means "use
   * the standard macOS location".
   */
  configPath: string | null
}

/**
 * Chords keyed by action id, then by app. A missing app key means unikeys has
 * nothing for that cell; a present entry with `chord: null` means unbound.
 */
export type ChordTable = Record<string, Partial<Record<AppId, StoredChord>>>

export interface Store {
  schemaVersion: number
  apps: Record<AppId, AppConfig>
  chords: ChordTable
  /**
   * Action ids whose row is linked. Linking keeps every mapped app's chord
   * equal; unlinking simply drops the id, which is what leaves each app holding
   * the last shared chord rather than reverting.
   */
  linkedActions: string[]
  firstRunCompleted: boolean
}

export function createEmptyStore(): Store {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    apps: Object.fromEntries(
      APP_IDS.map((id) => [id, { enabled: true, configPath: null } satisfies AppConfig])
    ) as Record<AppId, AppConfig>,
    chords: {},
    linkedActions: [],
    firstRunCompleted: false
  }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serializeStore(store: Store): string {
  return JSON.stringify(store, null, 2)
}

/**
 * Enabled apps the chord table has nothing at all for.
 *
 * This is how unikeys spots an app it gained in an update. Import runs once, on
 * the first run, and there is no re-import in the UI — so without this a column
 * added later would stay empty forever, with no way for the user to fill it.
 *
 * "Nothing at all" is deliberately strict. An app the user has merely unbound
 * everywhere still has entries (with `chord: null`), so it is not mistaken for
 * a new one and never re-imported behind their back.
 *
 * These are candidates, not a decision: an app that is not installed yields no
 * bindings and so would stay on this list forever. Callers are expected to
 * narrow it to apps actually present.
 */
export function appsMissingFromStore(store: Store): AppId[] {
  const seen = new Set<string>()
  for (const perApp of Object.values(store.chords)) {
    for (const app of Object.keys(perApp)) seen.add(app)
  }
  return APP_IDS.filter((app) => store.apps[app]?.enabled && !seen.has(app))
}

export type DeserializeOutcome = { ok: true; store: Store } | { ok: false; error: string }

/**
 * Reads a persisted store, filling in anything a newer schema has added so an
 * older document still loads. An unknown future version is refused rather than
 * misread.
 */
export function deserializeStore(text: string): DeserializeOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `Store is not valid JSON: ${(error as Error).message}` }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Store is not an object.' }
  }

  const data = raw as Partial<Store>
  const version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0
  if (version > STORE_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Store was written by a newer version of unikeys (schema ${version}).`
    }
  }

  const base = createEmptyStore()
  const store: Store = {
    schemaVersion: STORE_SCHEMA_VERSION,
    apps: { ...base.apps },
    chords: isRecord(data.chords) ? (data.chords as ChordTable) : {},
    linkedActions: Array.isArray(data.linkedActions)
      ? data.linkedActions.filter((id): id is string => typeof id === 'string')
      : [],
    firstRunCompleted: data.firstRunCompleted === true
  }

  if (isRecord(data.apps)) {
    for (const app of APP_IDS) {
      const config = (data.apps as Record<string, unknown>)[app]
      if (!isRecord(config)) continue
      store.apps[app] = {
        // Absent means enabled: a store written before this field existed should
        // not silently turn every column off.
        enabled: config.enabled !== false,
        configPath: typeof config.configPath === 'string' ? config.configPath : null
      }
    }
  }

  return { ok: true, store }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Reading cells
// ---------------------------------------------------------------------------

export function getStoredChord(
  chords: ChordTable,
  actionId: string,
  app: AppId
): StoredChord | undefined {
  return chords[actionId]?.[app]
}

export function isLinked(store: Store, actionId: string): boolean {
  return store.linkedActions.includes(actionId)
}
