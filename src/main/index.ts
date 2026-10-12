// Windows resolves a bare executable name against the spawning process's cwd before PATH; set
// this before anything (including a transitively-imported module) could spawn, so Refract itself
// never falls into that search order even indirectly (security fix, independent review).
process.env['NoDefaultCurrentDirectoryInExePath'] = '1'

import { app, BrowserWindow, Menu, nativeImage, session, shell } from 'electron'
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
import { cleanupModelRolesScratchDir } from './omp/config'
import { resetAllFileExplorerWatchersAndState, stopAllFileExplorerWatchers } from './ipc/fileExplorer'
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
export function openExternalSafe(url: string): void {
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

// Issue #494: the on-disk icon Refract ships for an unpackaged run (`build/icon.ico`,
// resolved relative to `out/main`). Dev-only -- see the `icon:`/`setIcon` comments below for why
// -- and shared with `registerNotifications` (notifications.ts) so a notification's own icon
// matches the window's.
const WINDOW_ICON_PATH = join(__dirname, '../../build/icon.ico')

// Issue #494 (2026-10-09 finding): every fresh, never-before-seen AppUserModelId worked with the
// current `icon:`/`setIcon` code (live harness at refract-taskbar-test/main.js), but the real
// packaged id, `com.stuarthopwood.refract`, kept showing the Electron atom even with that same
// code -- Windows had already cached a bad taskbar icon association for that exact string from
// an earlier unpackaged run (plausibly a scratch instance during PR #590's own verification) that
// showed a window under it before any icon was applied. No in-process fix repairs a poisoned id
// (`setAppDetails` did not help in the harness, even combined with `setIcon`). The only thing the
// harness proved fixes a poisoned real id is a different id, so dev runs use their own, distinct
// from the packaged one -- which also means a dev run can never poison or inherit the installed
// app's taskbar/notification identity in the first place.
const APP_USER_MODEL_ID_PACKAGED = 'com.stuarthopwood.refract'
const APP_USER_MODEL_ID_DEV = 'com.stuarthopwood.refract.dev'

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
    // `WINDOW_ICON_PATH` (`build/icon.ico`, resolved relative to `out/main`) only exists on an
    // unpackaged run: a packaged build never ships `build/` (spec 006 `electron-builder.yml`'s
    // `files: out/**/*`), so this option is a no-op there -- the packaged exe's own icon resource,
    // rcedit'd in by electron-builder's `win.icon` at packaging time (spec 006 T006), is what
    // Windows actually shows for a packaged run, not this option. Safe either way: an Electron API
    // that takes an image file path (this included) uses an empty, transparent image when the
    // path does not resolve, so a missing `build/` here never throws, it just does nothing.
    icon: WINDOW_ICON_PATH,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window

  // Issue #494 (bug fix): setting the icon again here, explicitly, after the window exists,
  // matches the issue's own fix direction ("test both together, since either alone may not be
  // enough") -- in the unpackaged launch method (`pnpm build` then `electron.exe .`, confirmed
  // live) Windows was resolving the taskbar/Alt-Tab/notification icon from the running
  // `electron.exe`'s own resource, because `app.setAppUserModelId` (called below, before
  // `createWindow()` runs here -- see the call site near the bottom of this file, now
  // `APP_USER_MODEL_ID_DEV` in dev) used to pin
  // the window's *identity* to that same executable; the constructor's `icon:` option above did
  // not override that. Like that option, this only ever affects an unpackaged run: a packaged
  // build's icon comes from the exe's own resource (spec 006), so `setIcon` here is a no-op
  // there regardless -- guarded explicitly ([INFERENCE]: not observed in an actual packaged
  // build, since spec 006 has not landed on `main` yet) so a packaged launch never pays for a
  // `createFromPath` read of a file it already knows does not exist.
  if (!app.isPackaged) {
    const windowIcon = nativeImage.createFromPath(WINDOW_ICON_PATH)
    if (!windowIcon.isEmpty()) window.setIcon(windowIcon)
  }

  window.on('ready-to-show', () => {
    window.show()
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

  // Gate round 8 fix (Sec8 Low): the renderer side of every file-explorer watcher's lifecycle
  // lives in a module-level ref-count `Map` in `FileExplorerPanel.tsx` -- a renderer reload or
  // crash resets that `Map` to empty, but main's own watchers (and the ancestor-folder lock each
  // one holds) are a SEPARATE process and keep running regardless, with nothing left to ever
  // call `stopWatching` again until the Session is archived/deleted/recreated or the whole app
  // quits. `render-process-gone` covers a crash; `did-navigate` (main frame, a genuine
  // CROSS-document navigation that actually COMMITTED -- see round 10's own correction just
  // below) covers a reload, including dev HMR's full-page fallback, PROVIDED the reload itself
  // commits -- round 11 correction (Code11/Sec11 Medium): `did-navigate` is never emitted for a
  // navigation that commits to an ERROR page instead (Electron's own `IsErrorPage()` check) --
  // a dev reload while the Vite server is down, or a `file://` reload with `index.html` itself
  // missing, replaces the whole document (every panel, every bit of renderer state) but fires
  // only `did-fail-provisional-load`/`did-fail-load`, never `did-navigate`, leaving every watcher
  // and ancestor lock stranded alive with nothing to ever release them until the NEXT successful
  // load. `did-fail-load` below closes that gap (`errorCode !== -3` excludes `ERR_ABORTED`, the
  // code for a navigation cancelled by `will-navigate`/a new navigation superseding it mid-
  // flight -- neither of those actually destroyed the document, so neither needs a reset). Both
  // `render-process-gone` and `did-navigate`/`did-fail-load` are a hard reset of the renderer's
  // entire in-memory state, so stopping every watcher unconditionally is correct -- the
  // renderer's own fresh mount re-calls `ensureWatching` for whichever Session(s) reopen a panel,
  // same as any other first open (moot for `did-fail-load`'s own error-page case, which shows no
  // panel to reopen a watcher for in the first place, but harmless either way).
  //
  // Gate round 9 fix (Sec9/Code9/A11y9/Verif9 HIGH, round 10 superseded below): the round-8
  // version of this handler used the deprecated positional `isMainFrame` argument and ignored
  // same-document navigations entirely -- Electron fires `did-start-navigation` for an in-page
  // (same-document) navigation too (a reference-fragment link, `pushState`/`replaceState`,
  // same-page history), and this app's own chat Markdown renders GFM footnote references/
  // back-links as plain `<a href="#user-content-fn...">` with no `preventDefault`
  // (`Markdown.tsx`) -- a perfectly ordinary click on one stopped EVERY watcher while every panel
  // stayed mounted, and since the renderer's own ref-count never changed (nothing unmounted),
  // `ensureWatching` was never called again: live refresh (FR-020) and deleted-preview detection
  // (FR-021) died silently for the rest of the run, the same class of regression round 8 itself
  // fixed, reintroduced by a fix that was only rated Low. Round 9's own fix added
  // `!details.isSameDocument` to `did-start-navigation`, which correctly let same-document
  // navigations through -- but round 10 (Sec10/Code10/Verif10 HIGH) found `did-start-navigation`
  // itself fires BEFORE Electron's own navigation throttles (`will-navigate`/
  // `will-frame-navigate` below, which `denyForeignNavigation` can cancel): a renderer-started
  // CROSS-document navigation that gets cancelled (an OS file dropped onto the window -- this
  // renderer has no `drop`/`dragover` handler at all, so Electron's own default navigation
  // kicks in -- or a dragged chat link) had ALREADY reset every watcher and cleared
  // `loadedPathsBySession` before the cancellation ran, with the page never actually navigating
  // away: every panel stayed mounted, nothing ever called `ensureWatching` again, and live
  // refresh/deleted-preview detection died exactly the same way as the original round-9 HIGH, on
  // a navigation that never even happened. Fixed: listens on `did-navigate` instead, which
  // Electron only emits for a main-frame cross-document navigation that actually COMMITTED (a
  // cancelled one never fires it at all, and an in-page/same-document one fires
  // `did-navigate-in-page` instead, a separate event this handler never needs to filter for) --
  // strictly simpler than the round-9 `did-start-navigation` + `isSameDocument` check it
  // replaces, and immune to the cancelled-navigation false-positive by construction.
  // Gate round 9 fix (Sec9/Code9/A11y9 Low): uses the combined reset (stops every watcher AND
  // clears `loadedPathsBySession`) rather than `stopAllFileExplorerWatchers` alone -- a renderer
  // crash/reload is a hard reset of ALL of its in-memory state, so the parked-path map a fresh
  // renderer has no knowledge of must reset with it, or its first `ensureWatching` would
  // re-flush folders the new renderer never opened.
  window.webContents.on('render-process-gone', () => resetAllFileExplorerWatchersAndState())
  window.webContents.on('did-navigate', () => resetAllFileExplorerWatchersAndState())
  // Gate round 11 fix (Code11/Sec11 Medium): see the comment at this effect's own top -- closes
  // the committed-error-page gap `did-navigate` itself cannot cover. `-3` is `ERR_ABORTED`
  // (Chromium's net error code), fired for a navigation cancelled by `will-navigate`/superseded
  // by a newer one mid-flight -- the OLD document was never actually replaced in either case, so
  // neither needs a reset (and `did-navigate` already covers the one that DID replace it).
  window.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) resetAllFileExplorerWatchersAndState()
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

    registerIpc(manager, getWindow, appMenu)
    registerNotifications(manager, getWindow, WINDOW_ICON_PATH)
    startMemoryMonitor(manager, getWindow)

    // Issue #494 (bug fix, matching spec 006 T012's already-landed choice on `spec-006-impl` for
    // the packaged id) -- the previous `process.execPath` pin (dev only) made Windows resolve the
    // taskbar/Alt-Tab/notification icon from the *identity* (the running `electron.exe`, whose
    // own resource is the Electron atom) rather than this window's own icon, even though
    // `createWindow()` sets one. A fixed, Refract-specific id is resolved independently of which
    // executable is currently running it. Packaged keeps the exact appId electron-builder.yml
    // will use (spec 006 T003 scaffolds that file's `appId`; T012 is this unconditional call;
    // `APP_USER_MODEL_ID_PACKAGED`) so notifications, taskbar grouping and Apps & Features stay
    // one identity across every upgrade, matching T012's intent even though packaging itself
    // (spec 006) has not landed on `main` yet. Dev uses `APP_USER_MODEL_ID_DEV` instead of that
    // same id -- see its comment above for why (a Windows-cached poisoned icon association for
    // the real id, found 2026-10-09).
    app.setAppUserModelId(isDev ? APP_USER_MODEL_ID_DEV : APP_USER_MODEL_ID_PACKAGED)

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
    // Best-effort, never blocking quit (issue #455 gate cycle 4 MEDIUM): removes the model-roles
    // scratch directory this session created, if any. Fires on EVERY `before-quit` pass,
    // including the re-entrant one `app.quit()` below triggers -- each call removes whatever
    // directory `cleanupModelRolesScratchDir` finds cached at that moment and does nothing if
    // none is cached (quality-gate remediation, gate cycle 6 LOW, security-auditor: previously
    // worded as "a no-op after its first successful call", which did not cover a model-roles IPC
    // call reaching `ensureScratchDir` between two passes and creating a fresh directory -- the
    // re-entrant second pass here is exactly what catches that one).
    void cleanupModelRolesScratchDir()
    // PR #671 gate round 4 fix (Low/Medium, Verif4/Sec4): releases every Session's file-watcher
    // handle on quit -- a watcher was otherwise only ever stopped by an explicit archive/delete/
    // recreateWorktree call or its own fatal self-detection, never by the app actually closing.
    stopAllFileExplorerWatchers()
    if (quitInFlight || !manager) return
    quitInFlight = true
    event.preventDefault()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, BEFORE_QUIT_STOP_ALL_TIMEOUT_MS))
    void Promise.race([manager.stopAll(), timeout]).then(() => {
      app.quit()
    })
  })
}
