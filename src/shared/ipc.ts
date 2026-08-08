/**
 * The typed IPC surface between the renderer and the main process.
 *
 * The renderer is pure UI: it never touches `fs`, never resolves a path, and
 * never talks to an adapter. Everything it knows about the outside world
 * arrives through these shapes.
 */

import type { AppId } from './apps'
import type { DefaultsAvailability } from './adapters/types'
import type { Catalogue } from './catalogue/types'
import type { HistoryEntry, NewHistoryEntry } from './history/types'
import type { ChordOrigin, Store } from './store/types'

// ---------------------------------------------------------------------------
// App status
// ---------------------------------------------------------------------------

/**
 * Why an app's column looks the way it does. Keeping these distinct is a
 * requirement in its own right: a parse failure must never be mistaken for
 * "this app has no bindings".
 */
export type AppHealth =
  | 'ok'
  | 'disabled'
  | 'not-installed'
  /**
   * No config yet, but unikeys knows where to put one and will create it on the
   * first save. The ordinary state of a fresh install — and the permanent state
   * of iTerm2 until the user saves, because its config is a Dynamic Profile
   * unikeys owns outright and no other program ever writes.
   */
  | 'config-not-created'
  /** No config, and no location unikeys may create one at. */
  | 'config-not-found'
  /**
   * No standard config location exists for this app at all, so unikeys needs
   * the user to name one before it can do anything. Distinct from
   * `config-not-found`, which means unikeys looked and came back empty: here
   * there was nowhere to look. Obsidian is the only app in this state — its
   * hotkeys live inside whichever vault is open.
   */
  | 'config-path-required'
  | 'config-unreadable'
  | 'config-unparseable'

export interface AppStatus {
  app: AppId
  name: string
  health: AppHealth
  installed: boolean
  enabled: boolean
  /** The path unikeys actually used, once resolved. */
  resolvedPath: string | null
  /**
   * Where a config that does not exist yet would be created. Present only for
   * `config-not-created`, so the UI can name the file it is about to make
   * instead of listing the places it failed to find one.
   */
  plannedPath?: string
  /** A path the user set by hand, if any. */
  overridePath: string | null
  /** Where unikeys looked, so a not-found message can say so. */
  searchedPaths: string[]
  /** Present when health is not `ok`. */
  message?: string
  /** Non-fatal parse problems — bad lines in an otherwise readable config. */
  problems: string[]
  /** How many bindings were read from the user's own config. */
  userBindingCount: number
  defaultsAvailability: DefaultsAvailability
  defaultsNote?: string
  reloadHint: string
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** One imported cell, ready to be folded into the store. */
export interface ImportedChord {
  actionId: string
  app: AppId
  /** Canonical chord string, or `null` for explicitly unbound. */
  chord: string | null
  origin: ChordOrigin
}

export interface ImportResult {
  chords: ImportedChord[]
  statuses: AppStatus[]
  /** Actions found, apps read, divergent rows — the first-run summary. */
  actionsFound: number
  appsRead: number
  /** Apps that could not be read, named rather than silently omitted. */
  appsFailed: Array<{ app: AppId; name: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadResult {
  store: Store
  catalogue: Catalogue
  statuses: AppStatus[]
  /** Where session backups are written, surfaced so the user can restore one. */
  backupDirectory: string
  storePath: string
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * What the renderer asks to be written: for each app, the managed bindings in
 * canonical form. The main process translates to each app's notation, since
 * notation is an adapter concern.
 */
export interface WriteRequest {
  bindings: Array<{
    actionId: string
    app: AppId
    /** Canonical chord string, or `null` to unbind. */
    chord: string | null
  }>
}

export interface WrittenApp {
  app: AppId
  name: string
  path: string
  /** Null when this file was already backed up earlier in the session. */
  backupPath: string | null
  reloadHint: string
}

export interface FailedApp {
  app: AppId
  name: string
  error: string
}

/** A chord the target app's format cannot express, reported rather than dropped. */
export interface SkippedBinding {
  app: AppId
  actionId: string
  chord: string
  reason: string
}

/**
 * A binding unikeys never attempted to write, and why. Distinct from `skipped`:
 * these never reached an adapter at all. Reporting them matters because a
 * silently dropped edit stays pending forever with nothing to explain it.
 */
export interface DroppedBinding {
  app: AppId
  actionId: string
  reason: string
  /**
   * True when unikeys dropped this deliberately and retrying cannot help — the
   * app is turned off, or the catalogue maps no command for it. The renderer
   * treats these as settled rather than leaving them pending forever.
   */
  deliberate: boolean
}

export interface WriteResult {
  written: WrittenApp[]
  /** Named precisely, so the user is never guessing about the state of their machine. */
  failed: FailedApp[]
  skipped: SkippedBinding[]
  dropped: DroppedBinding[]
  backupDirectory: string
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryResult {
  entries: HistoryEntry[]
  /** Set when an existing log could not be read. */
  error?: string
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const IPC = {
  load: 'unikeys:load',
  refreshStatuses: 'unikeys:refresh-statuses',
  importBindings: 'unikeys:import',
  persistStore: 'unikeys:persist-store',
  write: 'unikeys:write',
  loadHistory: 'unikeys:load-history',
  appendHistory: 'unikeys:append-history',
  chooseConfigPath: 'unikeys:choose-config-path',
  revealBackups: 'unikeys:reveal-backups',
  setThemeSource: 'unikeys:set-theme-source'
} as const

/**
 * Which appearance the window follows. `system` hands the decision back to
 * macOS.
 */
export type ThemeSource = 'light' | 'dark' | 'system'

export const THEME_SOURCES: readonly ThemeSource[] = ['light', 'dark', 'system']

export function isThemeSource(value: unknown): value is ThemeSource {
  return typeof value === 'string' && (THEME_SOURCES as readonly string[]).includes(value)
}

/**
 * The API the preload script exposes on `window.unikeys`. Declared here so the
 * renderer and the main process agree by construction.
 */
export interface UnikeysApi {
  load(): Promise<LoadResult>
  /**
   * Reads every configured app. Non-destructive: opening unikeys writes nothing.
   *
   * The store is passed in because the reducer lives in the renderer — main
   * persists state but does not hold the working copy.
   */
  importBindings(store: Store): Promise<ImportResult>
  /**
   * Re-reads every app's health without importing. Needed after the user
   * toggles an app or points unikeys at a different config, so the settings
   * panel is not left describing the previous configuration.
   */
  refreshStatuses(apps: Store['apps']): Promise<AppStatus[]>
  persistStore(store: Store): Promise<void>
  write(request: WriteRequest, store: Store): Promise<WriteResult>
  /**
   * The save log. Kept out of `load` deliberately: a corrupt log must not be
   * able to stop unikeys starting.
   */
  loadHistory(): Promise<HistoryResult>
  /**
   * Records one save and returns the log as it now stands.
   *
   * Main stamps the id and the timestamp, and applies the retention cap — so a
   * replayed message cannot mint a duplicate id, and the renderer's copy cannot
   * drift past the cap between restarts.
   */
  appendHistory(entry: NewHistoryEntry): Promise<HistoryEntry[]>
  /** Opens a file picker so a non-standard install does not block the user. */
  chooseConfigPath(app: AppId): Promise<string | null>
  revealBackups(): Promise<void>
  /**
   * Sets the appearance for the whole window, native chrome included.
   *
   * Main owns this rather than the renderer flipping a class, because the
   * traffic lights and the window background are drawn by macOS: with two
   * sources of truth they drift apart, and the buttons end up rendered for the
   * opposite appearance to the UI behind them.
   */
  setThemeSource(source: ThemeSource): Promise<void>
}
