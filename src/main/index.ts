import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { hasPendingAnalytics, shutdownAnalytics } from './analytics'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // The sidebar takes 240px and the two pinned table columns another ~330px.
    // At the old 820 that left the app columns under two columns' worth of
    // space between them. Note this also has to stay above 768: that is the
    // breakpoint at which the sidebar would collapse into a mobile drawer,
    // which is not a thing a desktop window should ever do.
    minWidth: 960,
    show: false,
    autoHideMenuBar: true,
    // The traffic lights sit over the renderer's own top strip instead of a
    // native title bar, so the window chrome and the sidebar read as one
    // surface. `.drag-region` in main.css is what keeps the window movable.
    //
    // `hidden` rather than `hiddenInset` because only `hidden` honours
    // `trafficLightPosition` — measured, not assumed: under `hiddenInset` the
    // property is ignored and the cluster stays at its default {x: 12, y: 11}.
    titleBarStyle: 'hidden',
    // The cluster measures 59.5×12 and this is its top-left, so y = 22 puts its
    // centre at 28 — the middle of the renderer's 56px (h-14) top strip. Move
    // that strip and this has to move with it, or the lights sit off-centre
    // against the controls beside them. Its right edge lands at 71.5, which is
    // where --traffic-light-inset's 80px in main.css comes from: 71.5 plus a
    // gap the eye reads as deliberate.
    trafficLightPosition: { x: 12, y: 22 },
    // Painted before the first frame, so resizing does not flash white.
    backgroundColor: '#16171b',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// A second instance would race the first on temp files and backups, and two
// windows disagreeing about the store is worse than no second window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Packaged builds get the icon from build/icon.icns; in dev the dock would
  // otherwise show the generic Electron icon.
  if (process.platform === 'darwin' && is.dev) {
    app.dock?.setIcon(icon)
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * Give analytics its one chance to flush before the process goes away.
 *
 * `before-quit` does not await an async listener, and `posthog-node` batches —
 * so without holding the quit open, everything captured since the last flush is
 * simply lost, which on a short session is the whole session. The quit is
 * deferred once, then re-issued; `flushed` is what stops the second `quit()`
 * from deferring again and looping forever.
 *
 * The race against a timer is not belt and braces: a machine that has gone
 * offline, or a captive-portal wifi that accepts the connection and never
 * answers, would otherwise leave the user holding a window that will not close.
 * Quitting promptly matters more than the last few events.
 */
let flushed = false
app.on('before-quit', (event) => {
  // The overwhelmingly common case, and it must cost nothing: a user who never
  // consented has no client, so there is nothing to flush and no reason to
  // interfere with their quit at all.
  if (flushed || !hasPendingAnalytics()) return
  event.preventDefault()
  const done = (): void => {
    flushed = true
    app.quit()
  }
  void Promise.race([
    shutdownAnalytics(),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]).then(done, done)
})
