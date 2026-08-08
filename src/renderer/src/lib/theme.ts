import { isThemeSource, type ThemeSource } from '@shared/ipc'

const STORAGE_KEY = 'unikeys.theme'

/**
 * The appearance preference.
 *
 * It lives in the renderer's own storage rather than in `Store`: it is a
 * property of this window, not of the user's keybindings, and putting it in the
 * store would mean a reducer action, a change to the persisted shape and a
 * migration for something that never leaves the UI.
 *
 * Main keeps no copy — it is told on every boot by `applyStoredTheme`.
 */
export function storedTheme(): ThemeSource {
  const raw = localStorage.getItem(STORAGE_KEY)
  return isThemeSource(raw) ? raw : 'system'
}

export function setTheme(source: ThemeSource): void {
  localStorage.setItem(STORAGE_KEY, source)
  void window.unikeys.setThemeSource(source)
}

/**
 * Pushes the saved preference to main at startup.
 *
 * `system` is skipped because it is already `nativeTheme`'s default, and
 * sending it would be a no-op round trip on every launch.
 */
export function applyStoredTheme(): void {
  const source = storedTheme()
  if (source !== 'system') void window.unikeys.setThemeSource(source)
}
