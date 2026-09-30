import { useState } from 'react'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ChatPane } from '@/features/chat/ChatPane'
import { ErrorBoundary } from '@/features/chat/ErrorBoundary'
import { Readiness } from '@/features/readiness/Readiness'
import { SessionList } from '@/features/sessions/SessionList'
import { StatusBar } from '@/features/status-bar/StatusBar'
import { useRepositoriesStore } from '@/state'

// Three-region layout (docs/DESIGN.md "Layout"): session list, chat, and a reserved right
// region for the later changes/files/side-chat pane, left unrendered until that spec ships. A
// fixed status bar runs along the bottom, outside the resizable regions. Before the readiness
// checklist passes or before a repository exists, this area shows the readiness screen instead
// (docs/DESIGN.md "First run and empty states"). Each region has its own ErrorBoundary so a
// render error in one (a malformed Session/TranscriptItem, say) cannot blank the other.
export function App() {
  const [ready, setReady] = useState(false)
  const hasRepositories = useRepositoriesStore((state) => state.repositories.length > 0)
  const showReadiness = !ready || !hasRepositories

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="min-h-0 flex-1">
        {showReadiness ? (
          <Readiness onReadyChange={setReady} />
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
          </ResizablePanelGroup>
        )}
      </div>
      <StatusBar />
    </div>
  )
}
