import { ElectronAPI } from '@electron-toolkit/preload'
import type { UnikeysApi } from '../shared/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    unikeys: UnikeysApi
  }
}
