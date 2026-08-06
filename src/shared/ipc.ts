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
  | 'config-not-found'
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

export interface WriteResult {
  written: WrittenApp[]
  /** Named precisely, so the user is never guessing about the state of their machine. */
  failed: FailedApp[]
  skipped: SkippedBinding[]
  backupDirectory: string
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const IPC = {
  load: 'unikeys:load',
  importBindings: 'unikeys:import',
  persistStore: 'unikeys:persist-store',
  write: 'unikeys:write',
  chooseConfigPath: 'unikeys:choose-config-path',
  revealBackups: 'unikeys:reveal-backups'
} as const

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
  persistStore(store: Store): Promise<void>
  write(request: WriteRequest, store: Store): Promise<WriteResult>
  /** Opens a file picker so a non-standard install does not block the user. */
  chooseConfigPath(app: AppId): Promise<string | null>
  revealBackups(): Promise<void>
}
