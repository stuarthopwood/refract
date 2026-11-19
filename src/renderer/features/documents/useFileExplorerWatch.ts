import { useEffect } from 'react'
import { fileExplorerWatch } from '@/state/watch-refs'

/** A file tab holds the file watcher while it is mounted, because the explorer panel is unmounted while a document tab is active. */
export function useFileExplorerWatch(sessionId: string): void {
  useEffect(() => {
    fileExplorerWatch.acquire(sessionId)
    return () => fileExplorerWatch.release(sessionId)
  }, [sessionId])
  useEffect(
    () =>
      window.refract.onFileExplorerReset(({ sessionId: resetSessionId }) => {
        if (resetSessionId === sessionId) fileExplorerWatch.restart(sessionId)
      }),
    [sessionId]
  )
}
