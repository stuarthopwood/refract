import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

const isDev = !app.isPackaged

function createWindow(): void {
  const mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Every window.open()/target=_blank request opens in the system browser, never a second
  // Electron window (constitution V: app windows must not load remote content).
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Block in-app navigation away from the renderer's own origin; hand any other URL to the
  // system browser instead of letting the window navigate to it.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const isOwnOrigin = rendererUrl ? url.startsWith(rendererUrl) : url.startsWith('file://')
    if (!isOwnOrigin) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
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
