/**
 * The typed IPC surface between the renderer and the main process.
 *
 * The renderer is pure UI: it never touches `fs`, never resolves a path, and
 * never talks to an adapter. Everything it knows about the outside world
 * arrives through these shapes.
 */

import type { AppId } from './apps'
// Type-only, and circular with `analytics.ts` importing `AppHealth` from here.
// Both sides are erased at compile time, so nothing circular survives to run.
import type { AnalyticsEvent } from './analytics'
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
  /**
   * The App Store build has no standing permission to reach this app's config
   * directory, so it has not looked. Only ever seen in a sandboxed build.
   *
   * Distinct from `config-not-found` on purpose, and the distinction is the
   * whole point of the state: "unikeys looked and found nothing" sends the user
   * to check whether the app is installed, when the truth is that unikeys was
   * never allowed to look. It is also distinct from `config-path-required`,
   * which is unikeys not knowing *where* to look — here the location is known
   * exactly, and `grantPath` carries it. Covers a grant never given and a grant
   * that has gone stale because the folder moved; the fix is the same picker
   * either way, so `message` carries which one happened.
   */
  | 'grant-required'
  | 'config-unreadable'
  | 'config-unparseable'

/**
 * Whether this health is something the user has to act on.
 *
 * Lives here, next to the union, because two places judge it — the Apps page
 * tones a card by it and the table banners unreadable apps by it — and they
 * were free to disagree. At six apps that cost little; at thirteen, `ok` is the
 * minority and every ordinary state gets loud. A config that does not exist
 * yet is not a problem: unikeys creates it on the first save. Nor is one whose
 * location unikeys never had — that is a question waiting for an answer, and
 * the Apps page is where it gets asked. A config awaiting a grant is the same
 * kind of question, and in the App Store build it is the state *every* app
 * starts in — tone thirteen cards as failures on first run and the user's
 * conclusion is that unikeys is broken, not that it is waiting for them.
 */
export function isHealthProblem(health: AppHealth): boolean {
  return (
    health !== 'ok' &&
    health !== 'disabled' &&
    health !== 'not-installed' &&
    health !== 'config-not-created' &&
    health !== 'config-path-required' &&
    health !== 'grant-required'
  )
}

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
  /**
   * The directory a sandboxed build needs granted for this app, and the folder
   * the picker opens at — which is what makes granting a hidden
   * `Library/Application Support` path bearable, since the panel itself runs
   * outside the sandbox and can start anywhere.
   *
   * Present for every app in a sandboxed build, not only ungranted ones: a user
   * re-granting a config they picked by hand has to be sent back to their own
   * folder, not to the standard location they already declined.
   *
   * Not simply `APPS[app].grantPath` expanded. It follows a hand-picked path,
   * and when a config is symlinked into a dotfiles repo it becomes the
   * directory holding the real file — which is only knowable after resolving
   * the link. Always absent outside the sandbox, where nothing is granted.
   */
  grantPath?: string
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
  /**
   * Whether this build runs under App Sandbox, and so whether the user is ever
   * asked to grant a folder. One flag for the whole session rather than a field
   * per app: it is a property of the build, and the renderer's only use for it
   * is deciding whether granting exists as a concept on the Apps page.
   */
  sandboxed: boolean
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/**
 * What came back from asking the user for a folder.
 *
 * A cancelled picker is separated from a rejected folder because they need
 * opposite treatment: closing the panel is the user deciding not to, and
 * showing an error for it would scold them for using the Cancel button. A
 * folder unikeys will not accept, on the other hand, needs saying out loud —
 * otherwise the picker just reopens and the user has no idea what went wrong.
 *
 * `directory` comes back alongside the bookmark because grants are stored per
 * folder: it is the key the new permission is filed under, and what stops a
 * second grant from evicting the first.
 */
export type GrantOutcome =
  | {
      ok: true
      grant: string
      directory: string
      /**
       * The override to store, or `null` to keep using the standard location.
       *
       * Decided here rather than in the renderer because it turns on whether the
       * chosen folder *is* the standard one, which only the main process knows.
       * Leaving it `null` in that case is not a tidiness point: an override
       * naming `.../JetBrains` would be taken literally, and glob expansion —
       * the thing that finds `WebStorm2024.3` — would never run.
       */
      configPath: string | null
    }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string }

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
  requestGrant: 'unikeys:request-grant',
  revealBackups: 'unikeys:reveal-backups',
  setThemeSource: 'unikeys:set-theme-source',
  track: 'unikeys:track',
  setAnalyticsEnabled: 'unikeys:set-analytics-enabled'
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
  /**
   * Opens a file picker so a non-standard install does not block the user.
   *
   * The dmg build only. A sandboxed build has `requestGrant` instead, which is
   * the same question asked once rather than twice — see there.
   */
  chooseConfigPath(app: AppId): Promise<string | null>
  /**
   * Asks the user for this app's config folder, returning the bookmark to
   * persist and the override to store with it.
   *
   * The sandboxed build's *only* way of pointing unikeys at a config, and that
   * is why it returns both. Under sandbox, choosing a location and granting
   * access are not two decisions the user could answer differently: the panel
   * that names the folder is the panel that grants it, and a path with no grant
   * behind it is a path unikeys cannot open. Offering "grant access" and
   * "choose config" separately asked one question twice, and the second answer
   * silently replaced the first.
   *
   * Its own call rather than something the read path does on demand, and that
   * is a load-bearing decision: a picker is asynchronous, and prompting from
   * inside `readConfig` would make every function between here and the
   * filesystem `async` — turning a change to two files into a change to all of
   * them. Reads and writes only ever redeem a grant that is already stored.
   *
   * A no-op outside the sandbox, where there is nothing to grant.
   *
   * `at` is where the picker should open, which the caller takes from the
   * status' `grantPath` — the standard location normally, the dotfiles repo
   * when the config turned out to be a link into one.
   */
  requestGrant(app: AppId, at?: string): Promise<GrantOutcome>
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
  /**
   * Records one anonymous usage event, if the user has said unikeys may.
   *
   * Fire and forget: it resolves whether or not anything was sent, and never
   * rejects. A call site is a save handler or a wizard step, and none of them
   * should acquire a `catch` because a measurement failed.
   *
   * The consent check lives in main rather than here, so the renderer cannot
   * send by getting the check wrong, and so there is one place to look when
   * asking whether this build is capable of sending at all. What may be sent is
   * `AnalyticsEvent`, which is a closed union — see `src/shared/analytics.ts`
   * for the rule about what a property may never carry.
   */
  track(event: AnalyticsEvent): Promise<void>
  /**
   * Answers the consent question, and persists the answer.
   *
   * Separate from `persistStore` because it has an effect beyond the store:
   * turning it off tears the PostHog client down for the rest of the session
   * rather than merely recording a preference to honour next launch.
   */
  setAnalyticsEnabled(enabled: boolean): Promise<void>
}
