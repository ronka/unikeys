/**
 * unikeys' own persisted state.
 *
 * unikeys is the source of truth: it maintains its own store of chords and app
 * configuration, and apps are write targets. There is no two-way sync and no
 * drift detection.
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

/**
 * Standing permissions for a sandboxed build, as base64 security-scoped
 * bookmarks keyed by the directory each one opens.
 *
 * A collection rather than a single bookmark, because one app can need two
 * directories at once and there is no order of granting that makes one do. A
 * config symlinked into a dotfiles repo is the case: reading it opens a path
 * under the standard location, while `writeAtomic` resolves the link and
 * creates its temp file in the repo. Both grants have to be held together, so
 * a lone `grant` field could only ever hold one and then report the other as
 * missing — with re-granting swapping which half was broken.
 *
 * Keyed by directory so that re-granting the same folder replaces its bookmark
 * instead of accumulating one per attempt, and so staleness can be attributed
 * to the directory that actually stopped opening.
 */
export type Grants = Record<string, string>

/** No permissions at all: the dmg build, and any path inside unikeys' own container. */
export const NO_GRANTS: Grants = {}

export interface AppConfig {
  enabled: boolean
  /**
   * A path the user set by hand when auto-detection failed. `null` means "use
   * the standard macOS location".
   */
  configPath: string | null
  /**
   * What a sandboxed build is allowed to open for this app. Empty means no
   * grant — either none was asked for (the dmg build never asks) or none was
   * given.
   *
   * Deliberately *not* a schema bump. The field is additive in both directions:
   * a build without it reads a store containing it and ignores the key, which
   * is what lets someone move between the dmg and App Store builds without
   * either refusing the other's store. Bumping the version would break that for
   * no gain, since nothing about the existing fields changed.
   */
  grants: Grants
}

/**
 * The two fields that answer "where is this app's config, and what may unikeys
 * open to get at it" — everything the file layer needs and nothing else.
 *
 * They travel as one value because they are never sourced apart: a path without
 * the permission to read it is not a location a sandboxed build can act on, and
 * a permission without a path opens nothing in particular. Passing them
 * separately made the grant a forgettable trailing argument, which in the dmg
 * build reads as harmless and in the App Store build silently means "no access".
 */
export type ConfigLocation = Pick<AppConfig, 'configPath' | 'grants'>

/** A location with no override and no grants: the standard path, unsandboxed. */
export const STANDARD_LOCATION: ConfigLocation = { configPath: null, grants: NO_GRANTS }

/**
 * Chords keyed by action id, then by app. A missing app key means unikeys has
 * nothing for that cell; a present entry with `chord: null` means unbound.
 */
export type ChordTable = Record<string, Partial<Record<AppId, StoredChord>>>

export interface Store {
  schemaVersion: number
  apps: Record<AppId, AppConfig>
  chords: ChordTable
  firstRunCompleted: boolean
  /**
   * Whether the onboarding wizard has been finished (or skipped). Separate from
   * `firstRunCompleted`, which the every-launch import sets as a side effect —
   * quitting mid-wizard leaves that `true` on disk, and this field is what lets
   * the wizard still reappear on the next launch. Additive on purpose, like
   * `grants`: no schema bump, so stores travel between builds either way.
   */
  onboardingCompleted: boolean
  analytics: AnalyticsConfig
}

/**
 * Whether unikeys may report anonymous usage, and who it says it is when it
 * does.
 *
 * `enabled: null` means the question has not been asked yet, and is not the
 * same as `false`. Only `true` sends anything: the onboarding wizard is where
 * the question gets asked, and a user who quits before reaching that step must
 * end up in the same silent state as one who declined.
 *
 * `distinctId` is a random UUID minted on first load — deliberately not the
 * hardware UUID, the hostname or anything else derivable back to a person or a
 * machine. It is generated whether or not analytics is on, so that turning it
 * on later does not fragment one user into two.
 */
export interface AnalyticsConfig {
  distinctId: string
  enabled: boolean | null
}

export function createEmptyStore(): Store {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    apps: Object.fromEntries(
      APP_IDS.map((id) => [id, { enabled: true, configPath: null, grants: {} } satisfies AppConfig])
    ) as Record<AppId, AppConfig>,
    chords: {},
    firstRunCompleted: false,
    onboardingCompleted: false,
    analytics: { distinctId: newDistinctId(), enabled: null }
  }
}

/**
 * A random identifier for this installation.
 *
 * `crypto.randomUUID` is present in the main process and in Electron's renderer
 * alike (`file://` counts as a secure context in Chromium), but the fallback is
 * kept because this module is plain shared code with no runtime it can insist
 * on, and an id that fails to mint would take the whole store down with it. The
 * fallback's weaker randomness costs nothing here: this value needs to be
 * unique, not unguessable — there is nothing to guess, since it identifies no
 * one.
 */
function newDistinctId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16)
  })
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serializeStore(store: Store): string {
  return JSON.stringify(store, null, 2)
}

/**
 * True when the chord table holds no entry at all for this cell.
 *
 * The whole of unikeys' backfill rule. Import re-reads every app on launch and
 * writes only where this is true, which is what lets a column, a row or a
 * default that unikeys learned about after the first run still reach the table.
 *
 * "No entry at all" is deliberately strict. A cell the user has set, or has
 * deliberately unbound (`chord: null`), has an entry and is left alone — so a
 * later import can never resurrect a default the user just switched off.
 */
export function isCellUnseen(store: Store, actionId: string, app: AppId): boolean {
  return store.chords[actionId]?.[app] === undefined
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
  // A store written while rows could be linked still carries `linkedActions`.
  // It is read past rather than migrated: linking was unikeys' own state and
  // never reached anyone's config, so dropping it leaves every app holding the
  // chord it already had — exactly what unlinking used to do.
  const store: Store = {
    schemaVersion: STORE_SCHEMA_VERSION,
    apps: { ...base.apps },
    chords: isRecord(data.chords) ? (data.chords as ChordTable) : {},
    firstRunCompleted: data.firstRunCompleted === true,
    // A store written before onboarding existed has no key, but a completed
    // first run means the user has already been through setup — treating them
    // as onboarded is what keeps the wizard from greeting existing users on
    // upgrade. Builds that know the field always write it, so an explicit
    // `false` (quit mid-wizard) survives even though `firstRunCompleted` is
    // already `true` by then.
    onboardingCompleted:
      data.onboardingCompleted === true ||
      (data.onboardingCompleted === undefined && data.firstRunCompleted === true),
    // Absent means "never asked", not "declined" — but the two behave
    // identically until the wizard asks, so an upgrading user is silent either
    // way. `base` already carries a freshly minted id, which is what a document
    // written before this field existed gets.
    analytics: readAnalytics(data.analytics, base.analytics.distinctId)
  }

  if (isRecord(data.apps)) {
    for (const app of APP_IDS) {
      const config = (data.apps as Record<string, unknown>)[app]
      if (!isRecord(config)) continue
      store.apps[app] = {
        // Absent means enabled: a store written before this field existed should
        // not silently turn every column off.
        enabled: config.enabled !== false,
        configPath: typeof config.configPath === 'string' ? config.configPath : null,
        grants: readGrants(config.grants)
      }
    }
  }

  return { ok: true, store }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the analytics settings a document carries.
 *
 * Anything other than an explicit `true` or `false` becomes `null`: a corrupt
 * or hand-edited value must fall back to asking, never to sending. `fallbackId`
 * is the freshly minted id from `createEmptyStore`, used when the document has
 * no usable one — reusing it rather than minting a second keeps this function
 * free of side effects.
 */
function readAnalytics(value: unknown, fallbackId: string): AnalyticsConfig {
  const stored = isRecord(value) ? value : {}
  const distinctId =
    typeof stored.distinctId === 'string' && stored.distinctId.length > 0
      ? stored.distinctId
      : fallbackId
  const enabled = stored.enabled === true ? true : stored.enabled === false ? false : null
  return { distinctId, enabled }
}

/**
 * Reads the grants a document carries, dropping anything that is not a
 * directory mapped to a bookmark.
 *
 * Filtered entry by entry rather than accepted or rejected whole: a single
 * malformed key is not a reason to discard permissions the user granted one at
 * a time, and a bookmark that survives but no longer opens is already handled —
 * it reports as stale and the same picker fixes it.
 */
function readGrants(value: unknown): Grants {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0
    )
  )
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
