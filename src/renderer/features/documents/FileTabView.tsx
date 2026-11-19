import { useEffect } from 'react'
import { useFileExplorerStore, useGitChangesStore } from '@/state'
import { useDocumentTabsStore } from '@/state/document-tabs-store'
import { FilePreviewPane } from '../right-pane/file-explorer/FilePreviewPane'
import { useGitChangesWatch } from '../right-pane/git-changes/useGitChangesWatch'
import { fileChangeSignature } from './file-reload'
import { useFileExplorerWatch } from './useFileExplorerWatch'
import { usePathActionHandlers } from './usePathActionHandlers'

interface FileTabViewProps {
  sessionId: string
  tabId: string
  path: string
}

/** A file tab: the shared preview, reloaded when the tab activates and whenever the Session's git snapshot says the file changed. */
export function FileTabView({ sessionId, tabId, path }: FileTabViewProps) {
  const entry = useFileExplorerStore((s) => s.previews[sessionId]?.[path])
  const view = useDocumentTabsStore((s) => s.bySession[sessionId]?.view[tabId])
  const signature = useGitChangesStore((s) => fileChangeSignature(s.bySession[sessionId]?.snapshot, path))
  const actions = usePathActionHandlers(sessionId)

  useFileExplorerWatch(sessionId)
  useGitChangesWatch(sessionId)
  useEffect(() => {
    void useGitChangesStore.getState().load(sessionId)
  }, [sessionId])
  // Mounting is activating: an inactive tab has no view, so it reloads here and again on each snapshot change.
  useEffect(() => {
    void useFileExplorerStore.getState().loadPreview(sessionId, path)
  }, [sessionId, path, signature])

  const setView = useDocumentTabsStore.getState().setViewState

  return (
    <FilePreviewPane
      path={path}
      preview={entry?.preview ?? null}
      previewLoading={entry?.loading ?? true}
      wrap={view?.wrap ?? false}
      showSource={view?.source ?? false}
      scrollTop={view?.scrollTop}
      onWrapChange={(wrap) => setView(sessionId, tabId, { wrap })}
      onSourceChange={(source) => setView(sessionId, tabId, { source })}
      onScrollTopChange={(scrollTop) => setView(sessionId, tabId, { scrollTop })}
      {...actions}
    />
  )
}
