// Windows resolves a bare executable name against the spawning process's cwd before PATH; set
// this before anything (including a transitively-imported module) could spawn, so Refract itself
// never falls into that search order even indirectly (security fix, independent review).
process.env['NoDefaultCurrentDirectoryInExePath'] = '1'

import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC_EVENTS } from '../shared/ipc'
import { THEMES, isThemeId } from '../shared/themes'
import { joinKillOnCloseJob } from './process/jobObject'
import { buildAppMenu } from './menu'
import { TITLE_BAR_OVERLAY_HEIGHT } from './titleBarOverlay'
import { initPidRecords, reapStale } from './process/pidRecords'
import { RegistryStore } from './store/registry'
import { SettingsStore } from './store/settings'
import { SessionManager } from './SessionManager'
import { registerIpc } from './ipc/register'
import { registerNotifications } from './notifications'
import { startMemoryMonitor } from './memory'
import { UpdateStateStore } from './store/updateState'
import { startAutomaticUpdateCheck } from './ipc/updates'
import { resolveInstallingState, scheduleInstallOnQuit } from './update/installOnQuit'

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
let updateStateStore: UpdateStateStore | undefined

// Spec 005 FR-015/data-model.md: set by `validateSplitAtStartup` when a restored split drops to
// exactly one surviving Session; sent as a one-time `ui:open-session` once the renderer's own
// listener for it is guaranteed registered (`did-finish-load` fires only after the page's
// top-level synchronous scripts -- including `main.tsx`'s `initStores()` call, which attaches
// that listener before React even mounts -- have already run). `validateSplitAtStartup` itself
// never calls `sessions.open`/starts an agent; the survivor DOES end up starting its own agent
// shortly after, once `replaceFocused` (triggered by this event) makes it the non-pristine
// single pane and that pane's own mount effect runs -- matching data-model.md's own restart-row
// entry ("not pristine... keeps today's single-pane behaviour, which does open it"), not the
// stricter never-starts-an-agent guarantee FR-014 makes specifically for restoring a real
// 2-session split.
let pendingSplitSurvivorId: string | undefined

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

/** Spec 005 FR-015/data-model.md Decision 3b: validates the persisted `Settings.split` against
 * `RegistryStore`'s already-loaded, in-memory `Session[]` -- never touches any agent. Drops any
 * id no longer present or now archived; if both survive, the split is left unchanged; otherwise
 * the corrected value (always `null` -- there is no one-element `SplitLayout`) is written back
 * so a stale id is never offered again. Returns the lone surviving Session id when exactly one
 * remains (so the caller can show it, focused, full width, once the renderer is ready --
 * `pendingSplitSurvivorId`'s own comment), or `undefined` otherwise. */
async function validateSplitAtStartup(manager: SessionManager): Promise<string | undefined> {
  const split = manager.settings.get().split
  if (!split) return undefined
  const liveSessionIds = new Set(
    manager.registry
      .snapshot()
      .sessions.filter((session) => session.archivedAt === null)
      .map((session) => session.id)
  )
  const survivors = split.sessionIds.filter((id) => liveSessionIds.has(id))
  if (survivors.length === split.sessionIds.length) return undefined // both still exist and are not archived
  await manager.settings.setSplit(null)
  if (survivors.length === 1) {
    manager.setVisible(survivors)
    return survivors[0]
  }
  return undefined
}

// Spec 007 FR-011/FR-012: every `BrowserWindow` Refract creates must start already in the saved
// theme's title-bar overlay colours, from its very first paint -- never the hardcoded dark one
// swapped in later. `manager` is already assigned (`SessionManager` constructed, which in turn
// already holds the fully-loaded `SettingsStore`) by the time this is ever called; the `?? 'dark'`
// fallback only guards a theoretical call before that, and `isThemeId` repeats `SettingsStore`
// .open's own FR-013 fallback defensively rather than trusting a value that already should be valid.
function currentTitleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const savedTheme = manager?.settings.get().theme
  const themeId = isThemeId(savedTheme) ? savedTheme : 'dark'
  return { ...THEMES[themeId].titleBarOverlay, height: TITLE_BAR_OVERLAY_HEIGHT }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // The title bar merged into the app's own top row (spec 001 T100, FR-057): the native menu
    // never reveals on Alt once `titleBarStyle: 'hidden'` is set (confirmed live,
    // docs/spike/FINDINGS.md item 33), so the renderer draws its own File/Edit/View/Window bar
    // instead (`AppMenuBar.tsx`, `menu.ts`'s `Menu.setApplicationMenu` keeps every accelerator
    // working regardless). `titleBarOverlay` paints the minimise/maximise/close buttons in the
    // active theme's colours (spec 007: read from the saved theme at creation time, kept in sync
    // afterward by `theme.preview`/`theme.set`'s own `applyTitleBarOverlay` calls).
    titleBarStyle: 'hidden',
    titleBarOverlay: currentTitleBarOverlay(),
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
    // FR-020, SC-010, contracts/ipc.md "Startup behaviour": kicked off after the window is
    // shown, never awaited before this call -- see startAutomaticUpdateCheck's own comment.
    if (updateStateStore) startAutomaticUpdateCheck(updateStateStore)
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  // Spec 005: delivers a restored split's lone surviving Session (see `pendingSplitSurvivorId`'s
  // own comment above) the first time this window's page finishes loading.
  window.webContents.on('did-finish-load', () => {
    if (!pendingSplitSurvivorId) return
    window.webContents.send(IPC_EVENTS.UI_OPEN_SESSION, { sessionId: pendingSplitSurvivorId })
    pendingSplitSurvivorId = undefined
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

    // Spec 006 FR-018, research.md decision 5: resolved before T021's automatic update check
    // below, and before anything else that could read `updateStateStore`'s phase -- a leftover
    // 'installing' phase from the previous run (the install-on-quit helper's own target
    // version compared against the version actually running now) must never be mistaken for
    // the current run's own fresh state.
    updateStateStore = await UpdateStateStore.open(userDataDir)
    await resolveInstallingState(updateStateStore, app.getVersion())

    // Spec 005 FR-015/data-model.md Decision 3b: drop any persisted split id no longer present
    // in the registry or now archived, before the renderer ever reads `settings.get()`. Reads
    // the registry only -- never starts an agent itself (FR-014). Quality-gate remediation
    // (security-auditor, HIGH): `SettingsStore.open`'s own shape check already keeps a malformed
    // `split` from ever reaching this function, but a thrown error here must still never prevent
    // `createWindow()` below from running -- this `async whenReady` chain has no other catch, and
    // an uncaught rejection would leave the single-instance lock held by a window-less process.
    try {
      pendingSplitSurvivorId = await validateSplitAtStartup(manager)
    } catch (err) {
      // Quality-gate remediation (code-reviewer, round 2, Low): this used to claim "continuing
      // with no split restored", which only held for the one failure site (`setSplit(null)`
      // throwing) where `SettingsStore`'s in-memory `data.split` is already cleared before the
      // write it awaits. An earlier throw (e.g. `registry.snapshot()`) leaves `settings.split`
      // completely untouched, and the renderer's own, independent `settings.get()`-driven
      // restore still runs regardless of this catch -- so a stale/archived id this pass was
      // meant to prune (FR-015) may still be offered this launch.
      console.error('main: validateSplitAtStartup failed; stale-id pruning for a restored split did not run this launch', err)
    }

    // T100: the one real application menu (accelerators work regardless of the merged top row
    // never showing a visible bar); the renderer's `AppMenuBar` pops its submenus by id.
    const appMenu = buildAppMenu(isDev)
    Menu.setApplicationMenu(appMenu)

    registerIpc(manager, getWindow, appMenu, updateStateStore)
    registerNotifications(manager, getWindow)
    startMemoryMonitor(manager, getWindow)

    // Spec 006 T012: unconditional, using the same appId electron-builder.yml uses
    // (research.md decision 1's uninstall-registry-key derivation) -- Windows notifications,
    // the taskbar icon, and the Apps & Features identity stay one identity across every
    // upgrade. A dev run shares this same fixed id too, rather than grouping under Electron's
    // own shared AppUserModelID.
    app.setAppUserModelId('com.stuarthopwood.refract')

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
    void Promise.race([manager.stopAll(), timeout]).then(async () => {
      // Spec 006 FR-015, FR-016, research.md decision 5: install only ever happens from a
      // verified, downloaded state, and only at a quit the developer already chose -- never
      // implied by any other phase. A scheduling failure (helper spawn failed) is logged and
      // Refract still quits normally rather than ever blocking quit on the update.
      const state = updateStateStore?.get()
      if (state?.phase === 'downloaded' && state.installerPath) {
        try {
          await updateStateStore?.update({ phase: 'installing' })
          await scheduleInstallOnQuit(state.installerPath, process.pid)
        } catch (err) {
          console.error('main: failed to schedule the update install-on-quit helper', err)
        }
      }
      app.quit()
    })
  })
}
