// Windows resolves a bare executable name against the spawning process's cwd before PATH; set
// this before anything (including a transitively-imported module) could spawn, so Refract itself
// never falls into that search order even indirectly (security fix, independent review).
process.env['NoDefaultCurrentDirectoryInExePath'] = '1'

import { app, BrowserWindow, session, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { joinKillOnCloseJob } from './process/jobObject'
import { initPidRecords, reapStale } from './process/pidRecords'
import { RegistryStore } from './store/registry'
import { SettingsStore } from './store/settings'
import { SessionManager } from './SessionManager'
import { registerIpc } from './ipc/register'
import { registerNotifications } from './notifications'
import { startMemoryMonitor } from './memory'

const isDev = !app.isPackaged

// Renamed from Pinion to Refract (issue #90). Electron derives the default userData folder from
// package.json "name", so pin it to the pre-rename folder: registry.json, settings.json, and
// processes.json stay put, and the single-instance lock (keyed on this folder) is shared with any
// older Pinion build, so the two can never drive the same Sessions at once. An explicit
// --user-data-dir (an isolated verification or side-by-side test instance) wins over the pin; an
// empty one does not, since Electron ignores it and would fall back to the post-rename folder.
// Must run before requestSingleInstanceLock() and 'ready'; setPath throws if the folder does not
// exist.
if (app.commandLine.getSwitchValue('user-data-dir') === '') {
  const pinnedUserDataDir = join(app.getPath('appData'), 'pinion')
  mkdirSync(pinnedUserDataDir, { recursive: true })
  app.setPath('userData', pinnedUserDataDir)
}

// Stop-all cap on quit (tasks.md T017): every agent gets this long to exit stdin-first before
// Refract quits anyway; the Job Object (jobObject.ts) is the backstop if a process wedges.
const BEFORE_QUIT_STOP_ALL_TIMEOUT_MS = 10_000

let mainWindow: BrowserWindow | undefined
let manager: SessionManager | undefined

function getWindow(): BrowserWindow | undefined {
  return mainWindow
}

/** Opens `url` in the system browser only when it parses and its protocol is `https:` or
 * `http:`; every other request (a malformed string, `file:`, a UNC path, `mailto:`, `javascript:`,
 * ...) is silently dropped. Never logs the URL itself, only whether/why it was dropped. */
function openExternalSafe(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    console.debug('main: dropped an external open request with an unparsable URL')
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.debug(`main: dropped an external open request with a disallowed protocol (${parsed.protocol})`)
    return
  }
  void shell.openExternal(parsed.href)
}

/** Exact match only, never a prefix check: in dev, the renderer dev server's own origin; in a
 * built app, the built `index.html` as a `file:` URL (hash ignored, since the renderer's own
 * client-side routing may set one). Anything else -- including a same-scheme, different-path
 * `file:` URL -- is not the app's own origin. */
function isOwnOrigin(url: string): boolean {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && rendererUrl) {
    try {
      return new URL(url).origin === new URL(rendererUrl).origin
    } catch {
      return false
    }
  }
  const indexHref = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  try {
    const target = new URL(url)
    target.hash = ''
    return target.href === indexHref
  } catch {
    return false
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // The dev-time window icon: `build/icon.ico` resolves relative to `out/main`, so this path
    // only exists when running unpackaged. Once spec 006's T006 adds electron-builder, it will
    // embed this same build/icon.ico in the packaged exe's own resource instead, wired through
    // electron-builder's config at packaging time, not through this `icon:` option. build/icon.ico
    // already carries a bitmap per size, so Windows picks the right one for the taskbar/Alt-tab/
    // title bar without re-scaling one image.
    icon: join(__dirname, '../../build/icon.ico'),
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
    openExternalSafe(details.url)
    return { action: 'deny' }
  })

  // Block in-app navigation away from the renderer's own exact origin (own-origin check, not a
  // prefix match); hand an allowed external URL to the system browser instead. `will-navigate`
  // only covers the main frame; `will-frame-navigate` is the same check for every frame
  // (including one a dropped file or a subframe would target), so neither a same-window
  // navigation nor a frame navigation can reach an arbitrary URL.
  const denyForeignNavigation = (event: { preventDefault: () => void }, url: string): void => {
    if (isOwnOrigin(url)) return
    event.preventDefault()
    openExternalSafe(url)
  }
  window.webContents.on('will-navigate', (event, url) => denyForeignNavigation(event, url))
  window.webContents.on('will-frame-navigate', (details) => denyForeignNavigation(details, details.url))

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

    // Refract needs no permission the OS/browser sandbox gates (camera, mic, geolocation,
    // notifications go through the main-process Notification API, not the renderer's).
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)

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
      // notifications are Refract's own, not electron.exe's.
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

  // Stops every live `omp` process before the app actually exits, so none outlives Refract
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
