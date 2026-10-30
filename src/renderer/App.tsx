import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeftRightIcon } from 'lucide-react'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useEnterOnSwitch } from '@/components/useEnterOnSwitch'
import { AppMenuBar } from '@/features/app-menu/AppMenuBar'
import { HomeView } from '@/features/home/HomeView'
import { ChatPane } from '@/features/chat/ChatPane'
import { ErrorBoundary } from '@/features/chat/ErrorBoundary'
import { Readiness } from '@/features/readiness/Readiness'
import { ManageSessionsScreen } from '@/features/profile/ManageSessionsScreen'
import { ProfileAlertRows } from '@/features/profile/ProfileAlertRows'
import { ProfileItem } from '@/features/profile/ProfileItem'
import { SessionList } from '@/features/sessions/SessionList'
import { SettingsScreen } from '@/features/settings/SettingsScreen'
import { PullRequestsView } from '@/features/pull-requests/PullRequestsView'
import { IssuesView } from '@/features/issues/IssuesView'
import { UsageView } from '@/features/usage/UsageView'
import { toast } from 'sonner'
import { StatusBar } from '@/features/status-bar/StatusBar'
import {
  RIGHT_PANE_DEFAULT_WIDTH_PX,
  RIGHT_PANE_MAX_WIDTH_PX,
  RIGHT_PANE_MIN_WIDTH_PX,
  useRepositoriesStore,
  useRightPaneStore,
  useSessionsStore,
  useSplitStore,
  useViewStore
} from '@/state'
import { IconRail } from '@/features/right-pane/IconRail'
import { RightPaneShell } from '@/features/right-pane/RightPaneShell'
import { RightPaneResizeHandle } from '@/features/right-pane/RightPaneResizeHandle'
import { rightPaneRef } from '@/features/right-pane/right-pane-handle'
import { resumeHostedPanels, suspendHostedPanels } from '@/features/right-pane/hosted-panel-actions'
import { useRightPaneShortcut } from '@/features/right-pane/use-right-pane-shortcut'
import { closeChatPane } from '@/features/chat/closeChatPane'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { focusSessionPane } from '@/lib/focus'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { announceQuickCreateFallback } from '@/features/sessions/quickCreateFallback'
import { createdSessionAnnouncement } from '@/features/sessions/createdSessionAnnouncement'

const MIN_SPLIT_WIDTH_PX = 360 * 2

export function App() {
  const [ready, setReady] = useState(false)
  const hasRepositories = useRepositoriesStore((state) => state.repositories.length > 0)
  const showReadiness = !ready || !hasRepositories
  const view = useViewStore((state) => state.view)
  const viewRef = useEnterOnSwitch(view, 'view')
  const rightPaneOpen = useRightPaneStore((state) => state.open)
  const paneShown = rightPaneOpen && view === 'chat'
  const paneSessionIds = useSplitStore((state) => state.paneSessionIds)
  const focusedIndex = useSplitStore((state) => state.focusedIndex)
  const dividerPercent = useSplitStore((state) => state.dividerPercent)
  const focusMoveButtonRef = useRef<HTMLButtonElement>(null)
  const [chatWidthPx, setChatWidthPx] = useState<number | null>(null)
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [liveDividerPercent, setLiveDividerPercent] = useState(dividerPercent)
  const isSplit = paneSessionIds.length === 2
  const canShowSplit = chatWidthPx !== null && chatWidthPx >= MIN_SPLIT_WIDTH_PX
  const showSplit = isSplit && canShowSplit
  // Index 0 for a single pane (focusedIndex is meaningless then), the focused pane for a split.
  const [paneA, paneB] = paneSessionIds
  const frontSessionId = paneSessionIds.length > 0 ? paneSessionIds[Math.min(focusedIndex, paneSessionIds.length - 1)] : null
  const unfocusedSessionId = isSplit ? paneSessionIds[focusedIndex === 0 ? 1 : 0] : null
  const unfocusedSessionName = useSessionsStore((state) =>
    unfocusedSessionId ? state.sessions.find((session) => session.id === unfocusedSessionId)?.name : undefined
  )
  const unfocusedSession = unfocusedSessionName !== undefined && unfocusedSessionId ? { id: unfocusedSessionId, name: unfocusedSessionName } : undefined
  const otherSessionForNarrowCollapse =
    isSplit && !canShowSplit && unfocusedSession ? { id: unfocusedSession.id, name: unfocusedSession.name } : null
  const focusedSessionName = useSessionsStore((state) =>
    isSplit ? state.sessions.find((session) => session.id === paneSessionIds[focusedIndex])?.name : undefined
  )
  const chatAreaAnnouncement = useChatAreaAnnouncer((s) => s.text)
  useEffect(() => {
    if (!isSplit) return
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.code !== 'Backslash') return
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      useSplitStore.getState().focusOther()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isSplit])

  // Ctrl+W closes the showing pane; `isSplit ? focusedIndex : 0` matches the JSX `paneIndex` below (#621).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
      const isW = latin ? event.key.toLowerCase() === 'w' : event.code === 'KeyW'
      if (
        !event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.repeat ||
        event.isComposing ||
        !isW
      )
        return
      if (showReadiness || view !== 'chat' || paneSessionIds.length === 0) return
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      closeChatPane(isSplit ? focusedIndex : 0)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showReadiness, view, paneSessionIds.length, isSplit, focusedIndex])

  // Ctrl+N: create in the focused pane's repo (or the only repo); otherwise focus the quick-create "+" rather than guess (#6).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
      const isN = latin ? event.key.toLowerCase() === 'n' : event.code === 'KeyN'
      if (
        !event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.repeat ||
        event.isComposing ||
        !isN
      )
        return
      if (showReadiness || view !== 'chat') return
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      const currentSessions = useSessionsStore.getState().sessions
      const focusedSession = frontSessionId
        ? currentSessions.find((session) => session.id === frontSessionId)
        : undefined
      const repositories = useRepositoriesStore.getState().repositories
      const target = focusedSession
        ? repositories.find((candidate) => candidate.id === focusedSession.repositoryId)
        : repositories.length === 1
          ? repositories[0]
          : undefined
      const repository = target?.defaultBranch ? target : undefined

      if (!repository) {
        const plus = document.querySelector<HTMLElement>('[data-quick-create-session]')
        plus?.focus()
        if (document.activeElement !== plus) announceQuickCreateFallback()
        return
      }

      if (useSessionsStore.getState().creatingRepositoryIds.has(repository.id)) return

      const origin = document.activeElement
      const originPaneContainer = origin?.closest('[data-session-pane]') ?? null

      // Announce immediately (worktree create takes seconds); a successful focus move stands in for a "created" announcement (#620).
      useChatAreaAnnouncer.getState().announce(`Creating session from ${repository.defaultBranch}`)
      void useSessionsStore
        .getState()
        .create(repository.id, repository.defaultBranch)
        .then((result) => {
          if (!result.ok) {
            toast.error(result.error.message, { duration: Infinity, closeButton: true })
            return
          }
          requestAnimationFrame(() => {
            const active = document.activeElement
            const stillHere =
              !active || active === document.body || !active.isConnected ||
              active === origin ||
              (originPaneContainer !== null && originPaneContainer.contains(active))
            if (!stillHere || !focusSessionPane(result.value.id)) {
              useChatAreaAnnouncer.getState().announce(createdSessionAnnouncement(result.value))
            }
          })
        })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : String(err), { duration: Infinity, closeButton: true })
        })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showReadiness, view, frontSessionId])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
      const isComma = latin ? event.key === ',' : event.code === 'Comma'
      if (
        !event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.repeat ||
        event.isComposing ||
        !isComma
      )
        return
      // Already in Settings: a no-op, not a second `openSettings()` call, which would reset
      // the open section back to the default and silently discard where the developer was.
      if (showReadiness || view === 'settings') return
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      useViewStore.getState().openSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showReadiness, view])

  useEffect(() => {
    function onPointerDownCapture(event: PointerEvent) {
      if (focusMoveButtonRef.current?.contains(event.target as Node)) event.preventDefault()
    }
    window.addEventListener('pointerdown', onPointerDownCapture, { capture: true })
    return () => window.removeEventListener('pointerdown', onPointerDownCapture, { capture: true })
  }, [])

  useEffect(() => {
    const visible = isSplit && canShowSplit ? paneSessionIds : frontSessionId ? [frontSessionId] : []
    window.refract.sessions.setVisible(visible).then(
      (result) => {
        if (!result.ok) console.error('sessions.setVisible failed', result.error)
      },
      (err: unknown) => console.error('sessions.setVisible threw', err)
    )
  }, [isSplit, canShowSplit, frontSessionId, paneSessionIds])

  useLayoutEffect(() => {
    const handle = rightPaneRef.current
    if (!handle) return
    if (paneShown) {
      // defaultSize is the 320px reset target, not the saved width, so a pane that mounts already
      // open starts at 320: apply the persisted width here (expand() alone returns to the library's
      // remembered size, not the restored width). A no-op when the size already matches.
      if (handle.isCollapsed()) handle.expand()
      handle.resize(useRightPaneStore.getState().widthPx)
    } else if (!handle.isCollapsed()) handle.collapse()
  }, [paneShown, showReadiness, view])

  useRightPaneShortcut(!showReadiness && view === 'chat')
  return (
    // #1200: `relative` makes this the containing block for every absolutely positioned descendant
    // (e.g. an `sr-only` node at the end of a long scroller); with `h-screen overflow-hidden` none can
    // grow or scroll the document.
    <div className="relative flex h-screen flex-col overflow-hidden">
      {/* Permanent drag strip (FR-057): Electron settles overlapping `-webkit-app-region` values
          by DOM document order, not paint/z-index (confirmed live), so this being the FIRST
          drag-region element in the tree means the left-nav header and the chat header (both
          declared later, whenever the workspace is showing) always win over it for the pixels
          they cover; the `-z-10` is cosmetic only (keeps it from ever visibly flashing), not what
          makes it inert there. It is the *only* drag-region source on the Readiness screen and the
          empty-chat state (especially with the session-list panel collapsed to 0 width) -- both
          leave the top row entirely unpainted otherwise, and with `titleBarStyle: 'hidden'`
          removing the real OS title bar, an unmovable window would result without it. */}
      <div aria-hidden className="drag-region fixed left-0 top-0 -z-10 flex h-10 w-full">
        <div
          aria-hidden
          className="no-drag-region ml-auto h-full"
          style={{ width: 'calc(100vw - env(titlebar-area-width, 100vw))' }}
        />
      </div>
      {/* Spec 005 (FR-022): one shared live region for the whole split, outside both panes and
          mounted whenever a split exists (even collapsed to one pane by the narrow-window
          rule), so a focus change -- including a narrow-window swap -- is announced exactly
          once (React only touches this text node when the computed string itself changes)
          rather than each pane re-reading on every unrelated re-render. */}
      {isSplit && <div aria-live="polite" className="sr-only">{focusedSessionName ? `Focused: ${focusedSessionName}` : ''}</div>}
      {/* Issue #621 (close chat pane): the "Closed {name} chat pane" announcement, always
          mounted here -- outside ChatPane entirely, per the decision -- not gated on
          `isSplit` like the region above, since closing the single, non-split pane down to
          zero is the one case that region's own gate would otherwise miss. */}
      <div aria-live="polite" className="sr-only">{chatAreaAnnouncement}</div>
      <div className="min-h-0 flex-1">
        {showReadiness ? (
          <Readiness onReadyChange={setReady} />
        ) : view === 'settings' ? (
          <div ref={viewRef} className="h-full"><ErrorBoundary>
            <SettingsScreen />
          </ErrorBoundary></div>
        ) : view === 'manage-sessions' ? (
          <div ref={viewRef} className="h-full"><ErrorBoundary>
            <ManageSessionsScreen />
          </ErrorBoundary></div>
        ) : (
          <div className="flex h-full overflow-hidden">
          <ResizablePanelGroup orientation="horizontal" className="h-full flex-1 min-w-0">
            <ResizablePanel
              id="session-list"
              defaultSize={280}
              minSize={220}
              maxSize={480}
              collapsible
              collapsedSize={0}
              onResize={(size) => setNavCollapsed(size.inPixels <= 0)}
            >
              {/* Quality-gate remediation (test-reviewer Medium; revised gate-3, UI N6 / A11y
                  M3): the `ResizablePanel` wrapper stays always mounted either way (so its own
                  pixel-exact sizing never changes), and now so does the content inside it --
                  `inert` + `aria-hidden` take it out of the Tab order and screen-reader browse
                  mode while collapsed, without unmounting it (and losing SessionList's own open
                  group/scroll/rename state) the way the previous conditional mount did. */}
              <ErrorBoundary>
                <div className="flex h-full flex-col" inert={navCollapsed} aria-hidden={navCollapsed || undefined}>
                  <div className="min-h-0 flex-1">
                    <SessionList />
                  </div>
                  <ProfileItem />
                  <ProfileAlertRows />
                </div>
              </ErrorBoundary>
            </ResizablePanel>
            <ResizableHandle withHandle aria-label="Resize session list" />
            <ResizablePanel id="chat" minSize={360} onResize={(size) => setChatWidthPx(size.inPixels)}>
              <div ref={viewRef} className="h-full"><ErrorBoundary>
                {view === 'pull-requests' ? (
                  <PullRequestsView reservesWindowControls={!paneShown} />
                ) : view === 'issues' ? (
                  <IssuesView reservesWindowControls={!paneShown} />
                ) : view === 'usage' ? (
                  <UsageView reservesWindowControls={!paneShown} />
                ) : view === 'home' || paneSessionIds.length === 0 ? (
                  // #869: Home is the no-pane screen and the nav's Home item.
                  <HomeView reservesWindowControls={!paneShown} />
                ) : !showSplit || paneA === undefined || paneB === undefined ? (
                  <ChatPane
                    sessionId={frontSessionId as string}
                    paneIndex={isSplit ? focusedIndex : 0}
                    reservesWindowControls={!paneShown}
                    otherSession={otherSessionForNarrowCollapse}
                    showWatermark
                    showAmbientLoop
                  />
                ) : (
                  <ResizablePanelGroup
                    orientation="horizontal"
                    className="relative h-full"
                    onLayoutChange={(layout) => {
                      const percent = layout['split-pane-0']
                      if (typeof percent === 'number') setLiveDividerPercent(percent)
                    }}
                    onLayoutChanged={(layout, meta) => {
                      if (!meta.isUserInteraction) return
                      const percent = layout['split-pane-0']
                      if (typeof percent === 'number') {
                        useSplitStore.getState().setDividerPercent(percent, { isUserInteraction: true })
                      }
                    }}
                  >
                    <ResizablePanel id="split-pane-0" defaultSize={`${dividerPercent}%`} minSize={360}>
                      <ErrorBoundary>
                        <ChatPane sessionId={paneA} paneIndex={0} reservesWindowControls={false} showAmbientLoop />
                      </ErrorBoundary>
                    </ResizablePanel>
                    <ResizableHandle withHandle aria-label="Resize chat panes" />
                    {/* Quality-gate remediation (accessibility-auditor, High x2; then a real
                        regression caught live during remediation re-verification; then a Tab-order
                        regression from the code-reviewer, round 2, Medium): the focus-move button
                        first lived INSIDE the Separator (`handleContent`), which made it a child of
                        `role="separator"` (ARIA: children presentational -- screen readers lost its
                        name) and let the library's own `keydown` handler on the Separator swallow
                        the button's native Enter activation. Wrapping the Separator itself in a
                        `relative` DIV sibling-fixed both of those but silently broke the library's
                        OWN arrow-key resize (confirmed live: 15x ArrowLeft on a correctly-focused,
                        correctly-labelled handle produced zero pixel change) -- the Separator must
                        stay a DIRECT child of this Group for its internal layout bookkeeping. This
                        button is a true sibling of both ResizablePanels and the Separator (not
                        wrapping anything), absolutely positioned via the Group's own `relative` root
                        at the live divider position -- not a descendant of the separator, and the
                        Separator's own DOM position in the Group is completely unchanged from the
                        library's expectations. It sits here, between the Separator and the second
                        Panel, so Tab order follows the divider's visual position (pane 0 ->
                        Separator -> this button -> pane 1) instead of landing after the entire
                        second pane's own content; the library's hit-region scan sorts by
                        `offsetLeft`, not DOM order, so this placement does not affect it. */}
                    <button
                      ref={focusMoveButtonRef}
                      type="button"
                      className="absolute top-1/2 z-20 flex size-6 -translate-x-1/2 -translate-y-10 items-center justify-center rounded border border-border bg-background text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      style={{ left: `${liveDividerPercent}%` }}
                      title="Move focus to other pane (Ctrl+Shift+\)"
                      aria-label="Move focus to the other pane"
                      aria-keyshortcuts="Control+Shift+\"
                      onClick={() => useSplitStore.getState().focusOther()}
                    >
                      <ArrowLeftRightIcon aria-hidden className="size-4" />
                    </button>
                    <ResizablePanel id="split-pane-1" defaultSize={`${100 - dividerPercent}%`} minSize={360}>
                      <ErrorBoundary>
                        {/* Spec 012 (research.md decision 3, FR-008): the right-most pane's own
                            reading area, never paneA -- "one watermark, not one per pane". */}
                        <ChatPane sessionId={paneB} paneIndex={1} reservesWindowControls={!paneShown} showWatermark />
                      </ErrorBoundary>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                )}
              </ErrorBoundary></div>
            </ResizablePanel>
            <RightPaneResizeHandle disabled={view !== 'chat'} />
            <ResizablePanel
              id="right-pane"
              panelRef={rightPaneRef}
              defaultSize={RIGHT_PANE_DEFAULT_WIDTH_PX}
              minSize={RIGHT_PANE_MIN_WIDTH_PX}
              maxSize={RIGHT_PANE_MAX_WIDTH_PX}
              collapsible
              collapsedSize={0}
              onResize={(size, _id, prevSize) => {
                if (prevSize === undefined) {
                  const paneStore = useRightPaneStore.getState()
                  if (size.inPixels > 0 && useViewStore.getState().view === 'chat' && paneStore.open) {
                    resumeHostedPanels(paneStore.openPanelIds)
                  }
                  return
                }
                const collapsed = size.inPixels <= 0
                const wasCollapsed = prevSize.inPixels <= 0
                if (collapsed === wasCollapsed) {
                  if (!collapsed) useRightPaneStore.getState().setWidth(size.inPixels)
                  return
                }
                const paneState = useRightPaneStore.getState()
                if (collapsed) {
                  suspendHostedPanels(paneState.openPanelIds)
                  if (useViewStore.getState().view === 'chat') {
                    paneState.syncRenderedState(false, paneState.widthPx)
                  }
                } else {
                  paneState.syncRenderedState(true, size.inPixels)
                  resumeHostedPanels(paneState.openPanelIds)
                }
              }}
            >
              <ErrorBoundary>
                <div className="h-full" inert={!paneShown} aria-hidden={!paneShown || undefined}>
                  <RightPaneShell sessionId={frontSessionId ?? null} />
                </div>
              </ErrorBoundary>
            </ResizablePanel>
          </ResizablePanelGroup>
          {view === 'chat' && <IconRail sessionId={frontSessionId ?? null} />}
          </div>
        )}
      </div>
      <StatusBar />
      {/* Rendered last (Electron computes `-webkit-app-region` override by DOM document order,
          not paint/z-index order, confirmed live: a `no-drag-region` element earlier in the tree
          than an overlapping `drag-region` one is silently outvoted and the OS still swallows the
          click as a window-drag) so its own `no-drag-region` root always wins over every
          drag-region header it can visually sit on top of (the permanent strip above, the left-nav
          header, and the chat header). */}
      <AppMenuBar />
    </div>
  )
}
