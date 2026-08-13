/**
 * The application menu.
 *
 * Electron installs a default menu when none is set, and that default has no
 * way to bring the main window back once it is closed — the Window menu it
 * builds from `role: 'windowMenu'` carries Minimize, Zoom and Close and nothing
 * that reopens anything. unikeys 1.0 (1.1.1) was rejected under App Store
 * Review Guideline 4 for precisely that: "when the user closes the main
 * application window there is no menu item to re-open it."
 *
 * So the Window menu is spelled out here rather than taken from the role. It is
 * an all-or-nothing choice: a role's submenu cannot be appended to, and the
 * moment one menu is declared by hand the whole menu bar has to be, which is
 * why `appMenu`, `editMenu` and `viewMenu` appear below. Dropping those would
 * take About, Services, Hide, Quit and copy/paste with them — its own rejection.
 */

import { Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * `show` is passed in rather than imported so this module never constructs a
 * window. It must be the same function the dock's `activate` handler uses:
 * an item wired straight to `createWindow` would open a *second* window every
 * time it was chosen, which is the state `requestSingleInstanceLock` exists to
 * keep unikeys out of.
 */
export function buildApplicationMenu(show: () => void): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      role: 'window',
      submenu: [
        // The item the rejection asked for. ⌘0 is the shortcut macOS apps
        // conventionally use for their main window, and the label is the app's
        // name because that is what the window is.
        { label: 'unikeys', accelerator: 'CmdOrCtrl+0', click: () => show() },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

export function installApplicationMenu(show: () => void): void {
  Menu.setApplicationMenu(buildApplicationMenu(show))
}
