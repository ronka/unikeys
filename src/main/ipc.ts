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
import {
  IPC,
  isThemeSource,
  type ChosenConfig,
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

  ipcMain.handle(
    IPC.chooseConfigPath,
    async (_event, appId: unknown): Promise<ChosenConfig | null> => {
      if (!isAppId(appId)) return null
      const sandboxed = isSandboxed()

      const result = await dialog.showOpenDialog({
        title: 'Choose config file',
        properties: sandboxed
          ? // Directory-only under sandbox. Naming the file itself would be the
            // friendlier panel, but the grant that came back would not cover the
            // temp file `writeAtomic` puts beside it — so unikeys would read the
            // config and then fail every save, which is worse than asking for
            // the folder. `configFileIn` and `resolveKeymapFile` already turn a
            // directory into the right file for the formats that need it.
            ['openDirectory', 'showHiddenFiles']
          : // JetBrains keymaps live in a directory whose filename the user
            // chose, so both a file and a directory are legitimate answers.
            ['openFile', 'openDirectory', 'showHiddenFiles'],
        securityScopedBookmarks: sandboxed
      })
      if (result.canceled || result.filePaths.length === 0) return null

      return {
        path: result.filePaths[0],
        grant: result.bookmarks?.[0] ?? (isSimulatedSandbox() ? SIMULATED_GRANT : null)
      }
    }
  )

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

      return { ok: true, grant: bookmark, directory }
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
}
