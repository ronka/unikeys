import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import { IPC, type UnikeysApi } from '../shared/ipc'

/**
 * The whole surface the renderer gets. Everything is a request to main; there
 * is no filesystem access here, and no way for the renderer to reach one by
 * accident.
 */
const unikeys: UnikeysApi = {
  load: () => ipcRenderer.invoke(IPC.load),
  importBindings: (store) => ipcRenderer.invoke(IPC.importBindings, store),
  persistStore: (store) => ipcRenderer.invoke(IPC.persistStore, store),
  write: (request, store) => ipcRenderer.invoke(IPC.write, request, store),
  chooseConfigPath: (app) => ipcRenderer.invoke(IPC.chooseConfigPath, app),
  revealBackups: () => ipcRenderer.invoke(IPC.revealBackups)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('unikeys', unikeys)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.unikeys = unikeys
}
