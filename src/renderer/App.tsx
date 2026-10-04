import { useLayoutEffect, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { AppMenuBar } from '@/features/app-menu/AppMenuBar'
import { ChatPane } from '@/features/chat/ChatPane'
import { ErrorBoundary } from '@/features/chat/ErrorBoundary'
import { Readiness } from '@/features/readiness/Readiness'
import { SessionList } from '@/features/sessions/SessionList'
import { SettingsScreen } from '@/features/settings/SettingsScreen'
import { StatusBar } from '@/features/status-bar/StatusBar'
import { useRepositoriesStore, useSubagentPanelStore, useViewStore } from '@/state'
import { SubagentPanel } from '@/features/subagents/SubagentPanel'

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
export function App() {
  const [ready, setReady] = useState(false)
  const hasRepositories = useRepositoriesStore((state) => state.repositories.length > 0)
  const showReadiness = !ready || !hasRepositories
  const view = useViewStore((state) => state.view)
  const panelOpen = useSubagentPanelStore((state) => state.open)
  const panelSessionId = useSubagentPanelStore((state) => state.sessionId)
  const subagentPanelRef = useRef<PanelImperativeHandle>(null)

  // Keeps the subagents Panel mounted at all times (collapsible/collapsedSize=0, same pattern
  // as SessionList's own left-nav panel) rather than conditionally mounting/unmounting it --
  // react-resizable-panels recomputes every sibling's size whenever the set of mounted Panels
  // changes, which would move the chat pane's width on open/close and break FR-020's "Close
  // restores the chat pane's size and scroll exactly as before". `useLayoutEffect` (not
  // `useEffect`) so the imperative collapse()/expand() call commits before the browser paints,
  // never flashing the panel at its expanded width first. Depends on `showReadiness`/`view`
  // too, not just `panelOpen`: the `ResizablePanelGroup` (and so `subagentPanelRef`'s handle)
  // only exists once the Readiness screen clears and `view` is `'chat'`/`'pull-requests'`/
  // `'manage-sessions'`, and a `[panelOpen]`-only dependency list never re-ran this effect for
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
            <ResizableHandle withHandle />
            <ResizablePanel id="chat" minSize={360}>
              <ErrorBoundary>
                <ChatPane />
              </ErrorBoundary>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              id="subagents"
              panelRef={subagentPanelRef}
              defaultSize={320}
              minSize={240}
              maxSize={520}
              collapsible
              collapsedSize={0}
            >
              <ErrorBoundary>{panelSessionId && <SubagentPanel sessionId={panelSessionId} />}</ErrorBoundary>
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
