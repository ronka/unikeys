import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type UnikeysApi } from '../shared/ipc'

/**
 * The whole surface the renderer gets. Everything is a request to main; there
 * is no filesystem access here, and no way for the renderer to reach one by
 * accident.
 */
const unikeys: UnikeysApi = {
  load: () => ipcRenderer.invoke(IPC.load),
  importBindings: (store) => ipcRenderer.invoke(IPC.importBindings, store),
  refreshStatuses: (apps) => ipcRenderer.invoke(IPC.refreshStatuses, apps),
  persistStore: (store) => ipcRenderer.invoke(IPC.persistStore, store),
  write: (request, store) => ipcRenderer.invoke(IPC.write, request, store),
  chooseConfigPath: (app) => ipcRenderer.invoke(IPC.chooseConfigPath, app),
  revealBackups: () => ipcRenderer.invoke(IPC.revealBackups),
  setThemeSource: (source) => ipcRenderer.invoke(IPC.setThemeSource, source)
}

// The scaffold's generic `electronAPI` bridge is deliberately not exposed: it
// accepts arbitrary IPC channel names and hands the renderer `process.env`,
// which is the opposite of the small typed surface this app is meant to have.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('unikeys', unikeys)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.unikeys = unikeys
}
