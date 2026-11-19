import { useEffect } from 'react'
import { fileExplorerWatch } from '@/state/watch-refs'

/** The explorer panel and each file tab hold the file watcher while mounted; it restarts after a backend reset. A null Session is a no-op. */
export function useFileExplorerWatch(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return
    fileExplorerWatch.acquire(sessionId)
    return () => fileExplorerWatch.release(sessionId)
  }, [sessionId])
  useEffect(() => {
    if (!sessionId) return
    return window.refract.onFileExplorerReset(({ sessionId: resetSessionId }) => {
      if (resetSessionId === sessionId) fileExplorerWatch.restart(sessionId)
    })
  }, [sessionId])
}
