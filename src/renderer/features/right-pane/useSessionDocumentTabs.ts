import { useMemo } from 'react'
import { useDocumentTabsStore, type DocumentTab } from '@/state/document-tabs-store'

const NO_TABS: DocumentTab[] = []

/** The tabs and selection of one Session, selected apart so view-state, recency and `openedFrom` writes do not re-render the strip or shell. */
export function useSessionDocumentTabs(sessionId: string | null): { tabs: DocumentTab[]; activeId: string | null } {
  const tabs = useDocumentTabsStore((s) => (sessionId ? s.bySession[sessionId]?.tabs : undefined)) ?? NO_TABS
  const activeId = useDocumentTabsStore((s) => (sessionId ? (s.bySession[sessionId]?.activeId ?? null) : null))
  return useMemo(() => ({ tabs, activeId }), [tabs, activeId])
}
