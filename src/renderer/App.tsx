import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeftRightIcon } from 'lucide-react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { AppMenuBar } from '@/features/app-menu/AppMenuBar'
import { ChatPane } from '@/features/chat/ChatPane'
import { ErrorBoundary } from '@/features/chat/ErrorBoundary'
import { Readiness } from '@/features/readiness/Readiness'
import { SessionList } from '@/features/sessions/SessionList'
import { SettingsScreen } from '@/features/settings/SettingsScreen'
import { PullRequestsView } from '@/features/pull-requests/PullRequestsView'
import { StatusBar } from '@/features/status-bar/StatusBar'
import { useRepositoriesStore, useSessionsStore, useSplitStore, useSubagentPanelStore, useViewStore } from '@/state'
import { SubagentPanel } from '@/features/subagents/SubagentPanel'

// Spec 005 (research.md Decision 6, FR-017): below this many pixels of chat-area width, two
// minimum-width panes (360px each, matching the "chat" ResizablePanel's own existing floor) can
// no longer both fit; the chat area shows one pane instead of two, with the other Session one
// click away via ChatHeader's swap chip.
const MIN_SPLIT_WIDTH_PX = 360 * 2

// Three-region layout (docs/DESIGN.md "Layout"): session list, chat, and the right region --
// spec 004's Subagents panel is its first occupant (FR-017 to FR-020), always mounted but
// collapsed to zero width until opened (see the `useLayoutEffect` below for why);
// a file browser and side chat (backlog issue #1) remain later tenants of the same region. A
// fixed status bar runs along the bottom, outside the resizable regions. Before the readiness
// checklist passes or before a repository exists, this area shows the readiness screen instead
// (docs/DESIGN.md "First run and empty states"). Each region has its own ErrorBoundary so a
// render error in one (a malformed Session/TranscriptItem, say) cannot blank the other.
// `AppMenuBar` mounts once here, outside both branches, so Alt reveals the File/Edit/View/Window
// bar (FR-057) no matter which screen is showing; it is deliberately the LAST element in this
// file (see its own comment below) so its `no-drag-region` always outranks every drag-region
// header underneath it.
//
// Spec 005: the chat region renders one `ChatPane` when `useSplitStore`'s `paneSessionIds` holds
// one id, or two side by side (a nested horizontal `ResizablePanelGroup`) when it holds two --
// unless the chat area is narrower than `MIN_SPLIT_WIDTH_PX` (research.md Decision 6), in which
// case only the focused pane renders, with the other Session reachable through its header's
// swap chip.
export function App() {
  const [ready, setReady] = useState(false)
  const hasRepositories = useRepositoriesStore((state) => state.repositories.length > 0)
  const showReadiness = !ready || !hasRepositories
  const view = useViewStore((state) => state.view)
  const panelOpen = useSubagentPanelStore((state) => state.open)
  const panelSessionId = useSubagentPanelStore((state) => state.sessionId)
  const sessions = useSessionsStore((state) => state.sessions)
  const paneSessionIds = useSplitStore((state) => state.paneSessionIds)
  const focusedIndex = useSplitStore((state) => state.focusedIndex)
  const dividerPercent = useSplitStore((state) => state.dividerPercent)
  const subagentPanelRef = useRef<PanelImperativeHandle>(null)
  const focusMoveButtonRef = useRef<HTMLButtonElement>(null)
  // Round 3 (code-reviewer, Low): starting this at `+Infinity` made `canShowSplit` wrongly
  // assume a wide window before the chat panel's first real `onResize` measurement lands (e.g.
  // at startup or just after a renderer reload) -- long enough to clear a hidden Session's unread
  // flag the `visible` effect below should not have touched yet. `null` means "not yet measured".
  const [chatWidthPx, setChatWidthPx] = useState<number | null>(null)
  // Quality-gate remediation (code-reviewer, round 2, High): the focus-move button's `left` was
  // reading the PERSISTED `dividerPercent`, which `onLayoutChanged` only updates once a drag or
  // keyboard resize finishes (the library's own docs: "not called until the pointer has been
  // released") -- so the button stayed at the old position for the whole drag, then jumped, and
  // never moved at all for a layout the library sets itself (a restored `dividerPercent` the
  // `minSize={360}` floor re-clamps, or a window resize). Tracks the Group's own `onLayoutChange`
  // instead (fires on every pointer move AND every programmatic layout change, not just completed
  // user interactions) purely for the button's own position; `dividerPercent`/`onLayoutChanged`
  // remain the persisted, debounced source of truth for everything else.
  // Round 3 (code-reviewer/test-reviewer, Medium): the sync effect this first shipped with
  // (`useEffect(() => setLiveDividerPercent(dividerPercent), [dividerPercent])`) raced the
  // Group's own mount-time `onLayoutChange` emit -- both fire for the same commit when a split
  // mounts with a restored `dividerPercent` the `minSize={360}` floor re-clamps, and the passive
  // effect below the Group's layout effect runs LAST, overwriting the library's correct clamped
  // value with the stale persisted one. Removed: `onLayoutChange` alone already covers every
  // case (it fires on every mount, not just drags/later changes), so the `useState` initial
  // value only matters for the one frame before that first mount emit lands.
  const [liveDividerPercent, setLiveDividerPercent] = useState(dividerPercent)

  const isSplit = paneSessionIds.length === 2
  const canShowSplit = chatWidthPx !== null && chatWidthPx >= MIN_SPLIT_WIDTH_PX
  const showSplit = isSplit && canShowSplit
  // "Whichever pane is front-and-center" regardless of whether a split is actually open right
  // now: index 0 for a single pane (focusedIndex is meaningless at that length), the focused
  // pane's id for a real split.
  const [paneA, paneB] = paneSessionIds
  const frontSessionId = paneSessionIds.length > 0 ? paneSessionIds[Math.min(focusedIndex, paneSessionIds.length - 1)] : null
  const unfocusedSessionId = isSplit ? paneSessionIds[focusedIndex === 0 ? 1 : 0] : null
  const unfocusedSession = unfocusedSessionId ? sessions.find((session) => session.id === unfocusedSessionId) : undefined
  const otherSessionForNarrowCollapse =
    isSplit && !canShowSplit && unfocusedSession ? { id: unfocusedSession.id, name: unfocusedSession.name } : null
  // Quality-gate remediation (accessibility-auditor, High): the shared aria-live announcer used
  // to mount only inside the `showSplit` branch, so a narrow-window collapse (still `isSplit`,
  // just rendering one pane) never announced its own swap-chip focus changes. Driven by
  // `isSplit` throughout instead, regardless of whether both panes currently fit on screen.
  const focusedSessionName = isSplit ? sessions.find((session) => session.id === paneSessionIds[focusedIndex])?.name : undefined

  // Spec 005 (FR-007, research.md Decision 8): Ctrl+Shift+\ moves focus to the other pane while
  // a split is open, active window-wide (same pattern MessageInput.tsx's Ctrl+Shift+X listener
  // uses); `event.code` (not `event.key`) targets the physical backslash key regardless of what
  // Shift produces on the current keyboard layout.
  useEffect(() => {
    if (!isSplit) return
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.code !== 'Backslash') return
      // Round 3 (accessibility-auditor, Low): skips while a modal dialog (DeleteDialog's
      // AlertDialog) is open -- without this, the chord could flip `focusedIndex` and move real
      // DOM focus into the OTHER pane's textarea while Radix's own FocusScope keeps keyboard
      // focus trapped inside the still-open dialog, leaving the "Focused" badge and live-region
      // announcement contradicting where focus (and the Escape/Enter keys) actually go. Round 3
      // (code-reviewer, Low): a bare `[role="dialog"]` also matched Radix's non-modal
      // `PopoverContent` (e.g. StatusBar's "Free up memory" popover) -- focus is not trapped
      // there, so the chord silently no-op'd while it was open for no reason. Narrowed to only
      // the dialogs that actually trap focus: `alertdialog` (always modal) and a `dialog` that
      // declares itself modal via `aria-modal="true"`.
      if (document.querySelector('[role="alertdialog"], [role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      useSplitStore.getState().focusOther()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isSplit])

  // Round 3 (code-reviewer/accessibility-auditor/test-reviewer, Low): the React
  // `onPointerDownCapture` prop this first shipped with on the button below never ran early
  // enough -- react-resizable-panels attaches its own `pointerdown` listener directly to
  // `ownerDocument` in the CAPTURE phase, and the capture phase always reaches `document` before
  // it reaches React's root container (where React's synthetic `onPointerDownCapture` actually
  // dispatches from), so the library's handler -- which focuses the Separator, flags an active
  // drag, and calls `preventDefault()` -- had already run by the time React's handler fired. A
  // native listener on `window` (earlier still in the capture path than `document`) that calls
  // `preventDefault()` itself when the event's target is inside this button pre-empts it for
  // real: the library's own handler bails out immediately whenever the event arrives already
  // `defaultPrevented`.
  useEffect(() => {
    function onPointerDownCapture(event: PointerEvent) {
      if (focusMoveButtonRef.current?.contains(event.target as Node)) event.preventDefault()
    }
    window.addEventListener('pointerdown', onPointerDownCapture, { capture: true })
    return () => window.removeEventListener('pointerdown', onPointerDownCapture, { capture: true })
  }, [])

  // Quality-gate remediation (test-reviewer, round 2, Medium; then round 3, Medium, same gap):
  // FR-018 ("a session shown in either pane counts as viewed") needs exactly ONE place deciding
  // what main thinks is visible. Round 2 kept `split-store.ts`'s own `syncVisible` calls (always
  // sending BOTH `paneSessionIds`) AND added this effect to narrow the result back down during
  // the narrow-window collapse -- but main's `setVisible` clears unread (and resets the
  // transcript) for every id made newly visible the MOMENT the store's wide call lands, before
  // this effect's own narrowing call ever reaches main; the hidden Session's unread flag was
  // already cleared by the time the correction arrived, so the hole stayed open for the most
  // common actions (a plain row click, "Open in split"). This effect is now the SOLE caller of
  // `sessions.setVisible` -- every `syncVisible` call was removed from `split-store.ts` -- and
  // covers every pane count, not just an open split: `paneSessionIds.length` 0 (nothing visible),
  // 1 (today's single-pane case), or 2 collapsed-by-width (only `frontSessionId`'s pane actually
  // renders) all resolve to exactly what's on screen.
  useEffect(() => {
    const visible = isSplit && canShowSplit ? paneSessionIds : frontSessionId ? [frontSessionId] : []
    window.refract.sessions.setVisible(visible).then(
      (result) => {
        if (!result.ok) console.error('sessions.setVisible failed', result.error)
      },
      (err: unknown) => console.error('sessions.setVisible threw', err)
    )
  }, [isSplit, canShowSplit, frontSessionId, paneSessionIds])

  // Keeps the subagents Panel mounted at all times (collapsible/collapsedSize=0, same pattern
  // as SessionList's own left-nav panel) rather than conditionally mounting/unmounting it --
  // react-resizable-panels recomputes every sibling's size whenever the set of mounted Panels
  // changes, which would move the chat pane's width on open/close and break FR-020's "Close
  // restores the chat pane's size and scroll exactly as before". `useLayoutEffect` (not
  // `useEffect`) so the imperative collapse()/expand() call commits before the browser paints,
  // never flashing the panel at its expanded width first. Depends on `showReadiness`/`view`
  // too, not just `panelOpen`: the `ResizablePanelGroup` (and so `subagentPanelRef`'s handle)
  // only exists once the Readiness screen clears and `view` is `'chat'`/`'pull-requests'`/
  // `'manage-sessions'`, and a `[panelOpen]`-only dependency list never ran this effect for
  // that later first mount (caught live: the panel rendered at its full `defaultSize` instead
  // of collapsed, the very regression this effect exists to prevent).
  useLayoutEffect(() => {
    const handle = subagentPanelRef.current
    if (!handle) return
    if (panelOpen && handle.isCollapsed()) handle.expand()
    else if (!panelOpen && !handle.isCollapsed()) handle.collapse()
  }, [panelOpen, showReadiness, view])

  return (
    <div className="flex h-screen flex-col overflow-hidden">
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
      <div className="min-h-0 flex-1">
        {showReadiness ? (
          <Readiness onReadyChange={setReady} />
        ) : view === 'settings' ? (
          <ErrorBoundary>
            <SettingsScreen />
          </ErrorBoundary>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel id="session-list" defaultSize={280} minSize={220} maxSize={480} collapsible collapsedSize={0}>
              <ErrorBoundary>
                <SessionList />
              </ErrorBoundary>
            </ResizablePanel>
            <ResizableHandle withHandle aria-label="Resize session list" />
            <ResizablePanel id="chat" minSize={360} onResize={(size) => setChatWidthPx(size.inPixels)}>
              <ErrorBoundary>
                {view === 'pull-requests' ? (
                  // specs/003-pull-request-management: swaps only this panel's content (never
                  // the session-list panel or the subagent panel, both of which stay mounted --
                  // "Pull requests" is a left-nav entry, not a separate shell).
                  <PullRequestsView />
                ) : paneSessionIds.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Select a Session or create one.
                  </div>
                ) : !showSplit || paneA === undefined || paneB === undefined ? (
                  <ChatPane
                    sessionId={frontSessionId as string}
                    paneIndex={isSplit ? focusedIndex : 0}
                    reservesWindowControls
                    otherSession={otherSessionForNarrowCollapse}
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
                      // research.md Decision 5: only a real drag or keyboard resize persists;
                      // the initial/restored mount's own layout-settle call is not a user
                      // choice.
                      if (!meta.isUserInteraction) return
                      const percent = layout['split-pane-0']
                      if (typeof percent === 'number') {
                        useSplitStore.getState().setDividerPercent(percent, { isUserInteraction: true })
                      }
                    }}
                  >
                    <ResizablePanel id="split-pane-0" defaultSize={`${dividerPercent}%`} minSize={360}>
                      <ErrorBoundary>
                        <ChatPane sessionId={paneA} paneIndex={0} reservesWindowControls={false} />
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
                      <ArrowLeftRightIcon aria-hidden className="size-3.5" />
                    </button>
                    <ResizablePanel id="split-pane-1" defaultSize={`${100 - dividerPercent}%`} minSize={360}>
                      <ErrorBoundary>
                        <ChatPane sessionId={paneB} paneIndex={1} reservesWindowControls />
                      </ErrorBoundary>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                )}
              </ErrorBoundary>
            </ResizablePanel>
            <ResizableHandle withHandle aria-label="Resize subagents panel" />
            <ResizablePanel
              id="subagents"
              panelRef={subagentPanelRef}
              defaultSize={320}
              minSize={240}
              maxSize={520}
              collapsible
              collapsedSize={0}
              onResize={(size, _id, prevSize) => {
                // High remediation (code-reviewer): the handle stays draggable even while
                // "collapsed" (nothing else disables it), so dragging it directly -- rather than
                // through the Subagents chip/Close button -- used to desync the real rendered
                // size from `useSubagentPanelStore`'s own `open` boolean: dragging an open panel
                // shut left `open: true` with no way back in (the chip's `openPanel` call is
                // already `true`, so nothing re-triggers the layout effect above), and dragging a
                // closed panel open showed an empty panel (`panelSessionId` still `null`). This
                // keeps the store in sync with the panel's REAL rendered size on every resize,
                // not just the state the store thinks it last commanded; `prevSize === undefined`
                // is the initial mount, which the layout effect above already owns.
                if (prevSize === undefined) return
                const collapsed = size.inPixels <= 0
                const wasCollapsed = prevSize.inPixels <= 0
                if (collapsed === wasCollapsed) return
                const panelState = useSubagentPanelStore.getState()
                if (collapsed && panelState.open) panelState.closePanel({ restoreFocus: false })
                // Spec 005 (tasks.md T031): dragging the panel open directly (not via a chip, see
                // ReadoutChips.tsx's `SubagentsChip`) falls back to the FOCUSED pane's Session,
                // the same default-target rule FR-008 already uses for an ambiguous row click --
                // never the singular `visibleSessionId` this used to read (removed by T012).
                else if (!collapsed && !panelState.open && frontSessionId) panelState.openPanel(frontSessionId)
                // Low remediation (code-reviewer, spec 004 final confirmation pass): dragging the
                // collapsed panel open while there is no Session shown at all (`frontSessionId`
                // null, so the branch above cannot call `openPanel`) left it visually expanded with
                // the store still `open: false` -- desynced again, the same root cause this whole
                // handler exists to prevent. Forces the real rendered panel back closed instead of
                // leaving that mismatch sitting there.
                else if (!collapsed && !panelState.open && !frontSessionId) subagentPanelRef.current?.collapse()
              }}
            >
              {/* Critical remediation (a11y + test-reviewer, same root cause from two angles):
                  gated on `panelOpen` too, not just `panelSessionId` -- collapsing this Panel to
                  zero width never unmounts its content (react-resizable-panels sets no
                  inert/hidden/display:none on a collapsed Panel), so the Close button and every
                  subagent row button stayed in the Tab order and in screen-reader browse mode
                  even while visually hidden. The `ResizablePanel` wrapper itself stays always
                  mounted either way (FR-020's pixel-exact sizing fix still holds); only the
                  content inside now actually unmounts when closed. */}
              <ErrorBoundary>{panelOpen && panelSessionId && <SubagentPanel sessionId={panelSessionId} />}</ErrorBoundary>
            </ResizablePanel>
          </ResizablePanelGroup>
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
