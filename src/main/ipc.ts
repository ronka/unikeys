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
import { isAppId } from '../shared/apps'
import {
  IPC,
  isThemeSource,
  type HistoryResult,
  type ImportResult,
  type LoadResult,
  type WriteRequest,
  type WriteResult
} from '../shared/ipc'
import type { HistoryEntry, NewHistoryEntry } from '../shared/history/types'
import type { Store } from '../shared/store/types'
import { createBackupSession, type BackupSession } from './config-files'
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
      storePath: loc.storePath
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
    const result = await dialog.showOpenDialog({
      title: 'Choose config file',
      // JetBrains keymaps live in a directory whose filename the user chose, so
      // both a file and a directory are legitimate answers.
      properties: ['openFile', 'openDirectory', 'showHiddenFiles']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

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
