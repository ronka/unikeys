/**
 * The main-process side of the IPC surface.
 *
 * Every handler here is the only way the renderer can reach the filesystem.
 * The renderer sends canonical chords and app ids; it never sends a path, a
 * file's contents, or anything in an app's own notation.
 */

import { app as electronApp, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { CATALOGUE } from '../shared/catalogue'
import { APPS, isAppId } from '../shared/apps'
import type { AnalyticsEvent } from '../shared/analytics'
import { capture, configureAnalytics, setEnabled } from './analytics'
import {
  IPC,
  isThemeSource,
  type GrantOutcome,
  type HistoryResult,
  type ImportResult,
  type LoadResult,
  type WriteRequest,
  type WriteResult
} from '../shared/ipc'
import type { HistoryEntry, NewHistoryEntry } from '../shared/history/types'
import { NO_GRANTS, STANDARD_LOCATION, type Store } from '../shared/store/types'
import {
  createBackupSession,
  grantDirectory,
  grantMismatch,
  sameDirectory,
  type BackupSession
} from './config-files'
import { isSandboxed, isSimulatedSandbox, SIMULATED_GRANT } from './grants'
import { appStatuses, importFromApps, writeToApps } from './apps-service'
import { createHistoryLog, type HistoryLog } from './history-file'
import { loadStore, saveStore, storeLocation, type StoreLocation } from './store-file'

/**
 * A file is backed up once per session rather than once per save, so the
 * session's first backup is the one that captures the pre-unikeys state.
 */
let backups: BackupSession | null = null
let location: StoreLocation | null = null
let history: HistoryLog | null = null

function ensureLocation(): StoreLocation {
  if (location === null) location = storeLocation(electronApp.getPath('userData'))
  return location
}

function ensureHistory(): HistoryLog {
  if (history === null) history = createHistoryLog(electronApp.getPath('userData'))
  return history
}

function ensureBackups(): BackupSession {
  if (backups === null) backups = createBackupSession(ensureLocation().backupDirectory, new Date())
  return backups
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.load, (): LoadResult => {
    const loc = ensureLocation()
    const { store, error } = loadStore(loc)
    const statuses = appStatuses(store.apps)

    // The earliest point at which unikeys knows both who it is and whether it
    // may say so. Until this runs, `capture` drops everything — which is the
    // behaviour a user who has never been asked must get, and also the reason
    // a store that failed to load leaves analytics off rather than defaulting
    // it on: `loadStore` returns a fresh store on error, and a fresh store has
    // `enabled: null`.
    configureAnalytics(store.analytics.distinctId, store.analytics.enabled)

    if (error) {
      // Surfaced as a problem on every column rather than swallowed, because a
      // store that failed to load means the table below is not the user's state.
      for (const status of statuses) status.problems.push(`unikeys store: ${error}`)
    }

    return {
      store,
      catalogue: CATALOGUE,
      statuses,
      backupDirectory: loc.backupDirectory,
      storePath: loc.storePath,
      sandboxed: isSandboxed()
    }
  })

  ipcMain.handle(IPC.refreshStatuses, (_event, apps: Store['apps']) => appStatuses(apps))

  ipcMain.handle(IPC.importBindings, (_event, store: Store): ImportResult => {
    return importFromApps(store, CATALOGUE)
  })

  ipcMain.handle(IPC.persistStore, (_event, store: Store): void => {
    saveStore(ensureLocation(), store)
  })

  ipcMain.handle(IPC.write, (_event, request: WriteRequest, store: Store): WriteResult => {
    return writeToApps(request, store, CATALOGUE, ensureBackups())
  })

  ipcMain.handle(IPC.loadHistory, (): HistoryResult => ensureHistory().load())

  ipcMain.handle(IPC.appendHistory, (_event, entry: NewHistoryEntry): HistoryEntry[] => {
    // Stamped here, not in the renderer: a message delivered twice would
    // otherwise mint two records claiming to be the same save.
    return ensureHistory().append(entry, { id: randomUUID(), at: Date.now() })
  })

  ipcMain.handle(IPC.chooseConfigPath, async (_event, appId: unknown): Promise<string | null> => {
    if (!isAppId(appId)) return null
    // The dmg build's picker, and only its. A sandboxed build reaches every
    // config through `requestGrant`, which asks for the folder and the
    // permission in one panel — so this handler no longer has a sandbox case to
    // carry, and a path with no grant behind it can no longer be stored.
    if (isSandboxed()) return null

    const result = await dialog.showOpenDialog({
      title: 'Choose config file',
      // JetBrains keymaps live in a directory whose filename the user chose, so
      // both a file and a directory are legitimate answers.
      properties: ['openFile', 'openDirectory', 'showHiddenFiles']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC.requestGrant,
    async (_event, appId: unknown, at: unknown): Promise<GrantOutcome> => {
      if (!isAppId(appId)) return { ok: false, cancelled: true }
      if (!isSandboxed()) {
        // Nothing to grant outside the sandbox, and the renderer should never
        // have offered the action. Reported as a cancel rather than an error so
        // a stray call cannot put a message on screen about a concept this
        // build does not have.
        return { ok: false, cancelled: true }
      }

      // `at` is where the picker opens, and the renderer sends it because the
      // status it came from already knows: for a symlinked config that is the
      // dotfiles repo, not the standard location. Falling back rather than
      // trusting it blindly, since it arrives from the renderer.
      const standard = grantDirectory(appId, STANDARD_LOCATION)
      const wanted = typeof at === 'string' && at.length > 0 ? at : standard

      const result = await dialog.showOpenDialog({
        title: `Grant access to ${APPS[appId].name}'s config folder`,
        message: `unikeys reads and writes ${APPS[appId].name}'s keybindings in this folder. It never touches anything else.`,
        buttonLabel: 'Grant Access',
        // A directory, never a file: `writeAtomic` publishes through a temp file
        // created beside its target, so a file-scoped grant would let unikeys
        // read a config it could not then save.
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
        defaultPath: wanted ?? undefined,
        // The flag that makes the grant outlive the dialog — and the process.
        // Ignored by non-mas builds, which is why this handler refuses to run
        // in one rather than handing back a bookmark that would never redeem.
        securityScopedBookmarks: true
      })

      if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true }

      const directory = result.filePaths[0]
      // A non-mas build hands back no bookmarks however the panel is
      // configured, so the simulation supplies one — otherwise the flow it
      // exists to demonstrate stops at the step it is demonstrating.
      const bookmark = result.bookmarks?.[0] ?? (isSimulatedSandbox() ? SIMULATED_GRANT : undefined)

      // Validated before the bookmark is handed back, so a folder unikeys will
      // not use is never persisted — and so nothing is ever written through a
      // grant the user gave by mistake. Checked under the brand-new bookmark
      // alone: it is the only one that can open the folder just chosen.
      const mismatch =
        wanted === null
          ? null
          : grantMismatch(
              appId,
              directory,
              wanted,
              bookmark ? { [directory]: bookmark } : NO_GRANTS
            )
      if (mismatch !== null) return { ok: false, cancelled: false, error: mismatch }

      if (!bookmark) {
        return {
          ok: false,
          cancelled: false,
          error:
            'macOS did not return a lasting permission for that folder, so unikeys would lose ' +
            'access as soon as it quits. Try granting it again.'
        }
      }

      // An override only when they picked somewhere other than the standard
      // location. Storing the standard directory as an override would have it
      // taken literally — and for the JetBrains three that means never running
      // the glob that finds the versioned folder.
      const configPath = standard !== null && sameDirectory(directory, standard) ? null : directory

      return { ok: true, grant: bookmark, directory, configPath }
    }
  )

  ipcMain.handle(IPC.revealBackups, (): void => {
    const directory = ensureLocation().backupDirectory
    mkdirSync(directory, { recursive: true })
    shell.openPath(directory)
  })

  ipcMain.handle(IPC.setThemeSource, (_event, source: unknown): void => {
    // Validated like every other handler input — the renderer is trusted to be
    // well-behaved, not to be correct.
    if (!isThemeSource(source)) return
    // Setting it here rather than in the renderer is the whole point: macOS
    // draws the traffic lights and the window background, and the renderer's
    // `prefers-color-scheme` follows this, so the two cannot disagree.
    nativeTheme.themeSource = source
  })

  ipcMain.handle(IPC.track, (_event, event: unknown): void => {
    // Validated by `capture` itself, which sanitises against the same contract
    // the renderer was typed against. Anything unrecognised is dropped there
    // rather than forwarded, so this handler only has to reject the shapes that
    // are not events at all.
    if (typeof event !== 'object' || event === null || !('name' in event)) return
    capture(event as AnalyticsEvent)
  })

  ipcMain.handle(IPC.setAnalyticsEnabled, (_event, enabled: unknown): void => {
    if (typeof enabled !== 'boolean') return
    // Persisted here rather than left to the renderer's usual persist effect,
    // because consent must survive a crash between the click and the next
    // store write.
    //
    // That does make two writers for one field: the renderer dispatches
    // `setAnalyticsEnabled` too, and its persist effect will write the same
    // store moments later. Benign, and worth the duplication — both write the
    // identical value, `saveStore` is atomic, and whichever lands second lands
    // the same bytes. The alternative, trusting the persist effect alone, is
    // what loses the answer if the app dies in between.
    //
    // This handler must stay synchronous. The wizard awaits it before sending
    // its funnel events, and `capture` drops everything until it has run.
    const loc = ensureLocation()
    const { store } = loadStore(loc)
    saveStore(loc, { ...store, analytics: { ...store.analytics, enabled } })
    // `setEnabled` rather than `configureAnalytics`, and the difference is the
    // order: opting out has to capture the opt-out event *before* the client is
    // torn down, which reconfiguring first would make impossible.
    setEnabled(enabled)
  })
}
