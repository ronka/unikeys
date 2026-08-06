import type { UnikeysApi } from '../shared/ipc'

declare global {
  interface Window {
    unikeys: UnikeysApi
  }
}
