import { useEffect } from 'react'
import { gitChangesWatch } from '@/state/watch-refs'

/** Holds the Git watcher for a Session while the caller is mounted; the panel and every diff tab each hold it, so none stops it under another. */
export function useGitChangesWatch(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return
    gitChangesWatch.acquire(sessionId)
    return () => gitChangesWatch.release(sessionId)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    return window.refract.onFileExplorerReset(({ sessionId: resetSessionId }) => {
      if (resetSessionId === sessionId) gitChangesWatch.restart(sessionId)
    })
  }, [sessionId])
}
