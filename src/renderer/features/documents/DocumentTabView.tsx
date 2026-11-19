import { RequiresRepository } from '@/components/RequiresRepository'
import { useDocumentTabsStore } from '@/state/document-tabs-store'
import { DiffTabView } from './DiffTabView'
import { FileTabView } from './FileTabView'

interface DocumentTabViewProps {
  sessionId: string
  tabId: string
}

/** The active document tab's content. The tab's identity picks the view; a tab closed in the same tick renders nothing. */
export function DocumentTabView({ sessionId, tabId }: DocumentTabViewProps) {
  const tab = useDocumentTabsStore((s) => s.bySession[sessionId]?.tabs.find((candidate) => candidate.id === tabId))
  if (!tab) return null
  return (
    <RequiresRepository sessionId={sessionId}>
      {/* Keyed by the tab so each tab keeps its own load state and scroll restore. */}
      {tab.kind === 'file' ? (
        <FileTabView key={tab.id} sessionId={sessionId} tabId={tab.id} path={tab.path} />
      ) : (
        <DiffTabView key={tab.id} sessionId={sessionId} tabId={tab.id} group={tab.group} path={tab.path} />
      )}
    </RequiresRepository>
  )
}
