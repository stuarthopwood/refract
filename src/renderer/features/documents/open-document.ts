import { toast } from 'sonner'
import { MAX_DOCUMENT_TABS_PER_SESSION } from '../../../shared/rightPane'
import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { useDocumentTabsStore, documentTabId, type DocumentTab, type DocumentTabIdentity, type OpenResult } from '@/state/document-tabs-store'
import { resolveActiveTab, useRightPaneStore } from '@/state/right-pane-store'

export interface OpenDocumentOptions {
  /** Ctrl+click and Ctrl+Enter: the tab opens but the selection and focus stay where they are. */
  background?: boolean
  /** `false` for an agent open: the tab activates but takes no focus. */
  focus?: boolean
  /** Polite announcement for the open; sent with any eviction text in one call, as a second call would replace the first. */
  announce?: string
}

export interface OpenDocumentResult extends OpenResult {
  /** The tab was already open, so the shell sees no new tab and will not move focus itself. */
  existed: boolean
}

/** "Closed Foo.ts (20-tab limit)": the one wording for the polite region and the toast (FR-010). */
export function evictionMessage(tab: Pick<DocumentTab, 'path'>): string {
  return `Closed ${tab.path.split('/').pop()} (${MAX_DOCUMENT_TABS_PER_SESSION}-tab limit)`
}

/** The one way a row, a tool or the agent opens a file or diff tab (FR-002, FR-005, FR-006, FR-010). */
export function openDocument(
  sessionId: string,
  identity: DocumentTabIdentity,
  { background = false, focus = true, announce }: OpenDocumentOptions = {}
): OpenDocumentResult {
  const documents = useDocumentTabsStore.getState().bySession[sessionId]
  const existed = documents?.tabs.some((tab) => tab.id === documentTabId(identity)) ?? false
  const openedFrom = resolveActiveTab(sessionId, useRightPaneStore.getState().activePanelId, documents) ?? undefined
  const result = useDocumentTabsStore.getState().openDocumentTab(sessionId, identity, { activate: !background, openedFrom })
  if (!background) {
    // The shell only skips focus for a new tab, so an existing one must not leave the flag set for a later open.
    useRightPaneStore.setState({ open: true, suppressNextContentFocus: !focus && !existed })
    useRightPaneStore.getState().activateTab({ kind: 'document', sessionId, id: result.id }, sessionId)
  }
  const evicted = result.evicted ? evictionMessage(result.evicted) : null
  const spoken = [announce, evicted].filter((part): part is string => Boolean(part)).join('. ')
  if (spoken) useAgentAnnouncementStore.getState().announce(spoken)
  if (evicted) toast(evicted)
  return { ...result, existed }
}
