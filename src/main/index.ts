import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { joinKillOnCloseJob } from './process/jobObject'
import { initPidRecords, reapStale } from './process/pidRecords'
import { RegistryStore } from './store/registry'
import { SettingsStore } from './store/settings'
import { SessionManager } from './SessionManager'
import { registerIpc } from './ipc/register'
import { registerNotifications } from './notifications'
import { startMemoryMonitor } from './memory'

const isDev = !app.isPackaged
// Stop-all cap on quit (tasks.md T017): every agent gets this long to exit stdin-first before
// Pinion quits anyway; the Job Object (jobObject.ts) is the backstop if a process wedges.
const BEFORE_QUIT_STOP_ALL_TIMEOUT_MS = 10_000

let mainWindow: BrowserWindow | undefined
let manager: SessionManager | undefined

function getWindow(): BrowserWindow | undefined {
  return mainWindow
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  // T037: SessionAgent's unread tracking needs real OS focus, not just "a window exists".
  window.on('focus', () => manager?.setWindowFocused(true))
  window.on('blur', () => manager?.setWindowFocused(false))

  // Every window.open()/target=_blank request opens in the system browser, never a second
  // Electron window (constitution V: app windows must not load remote content).
  window.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Block in-app navigation away from the renderer's own origin; hand any other URL to the
  // system browser instead of letting the window navigate to it.
  window.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const isOwnOrigin = rendererUrl ? url.startsWith(rendererUrl) : url.startsWith('file://')
    if (!isOwnOrigin) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = getWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.whenReady().then(async () => {
    const jobResult = joinKillOnCloseJob()
    if (!jobResult.ok) {
      console.warn(`main: joinKillOnCloseJob failed, continuing without kill-on-close containment: ${jobResult.error ?? 'unknown reason'}`)
    }

    const userDataDir = app.getPath('userData')
    await initPidRecords(userDataDir)
    await reapStale()

    const registry = await RegistryStore.open(userDataDir)
    const settings = await SettingsStore.open(userDataDir)
    manager = new SessionManager(registry, settings)
    registerIpc(manager, getWindow)
    registerNotifications(manager, getWindow)
    startMemoryMonitor(manager, getWindow)

    if (isDev) {
      // Windows would otherwise group the dev binary under Electron's own shared
      // AppUserModelID; pin it to the running executable so taskbar grouping and
      // notifications are Pinion's own, not electron.exe's.
      app.setAppUserModelId(process.execPath)
    }

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // Stops every live `omp` process before the app actually exits, so none outlives Pinion
  // (constitution III). Re-entrant: the `app.quit()` this triggers fires `before-quit` again,
  // and `quitInFlight` lets that second pass through.
  let quitInFlight = false
  app.on('before-quit', (event) => {
    if (quitInFlight || !manager) return
    quitInFlight = true
    event.preventDefault()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, BEFORE_QUIT_STOP_ALL_TIMEOUT_MS))
    void Promise.race([manager.stopAll(), timeout]).then(() => {
      app.quit()
    })
  })
}
