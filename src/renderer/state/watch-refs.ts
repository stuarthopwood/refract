import { useGitChangesStore } from './git-changes-store'

// A watcher is per Session, but the file explorer, Git changes panel and the file and diff tabs all need it live. One
// count per watcher kind keeps the last view to leave from stopping it under the others (#2075 FR-012, FR-032).

interface WatchCall {
  ok: boolean
  error?: unknown
}

export interface WatchRefs {
  /** Starts the watcher on the first holder of a Session. */
  acquire(sessionId: string): void
  /** Stops it when the last holder of a Session leaves. */
  release(sessionId: string): void
  /** Re-sends the start call without touching the count (the main process dropped its watcher). */
  restart(sessionId: string): void
}

export function createWatchRefs(
  label: string,
  ensure: (sessionId: string) => Promise<WatchCall>,
  stop: (sessionId: string) => Promise<WatchCall>,
  onLastRelease?: (sessionId: string) => void
): WatchRefs {
  const counts = new Map<string, number>()
  const run = (action: string, call: Promise<WatchCall>) =>
    call
      .then((result) => {
        if (!result.ok) console.warn(`${label}: ${action} failed`, result.error)
      })
      .catch((error) => console.warn(`${label}: ${action} rejected`, error))

  return {
    acquire(sessionId) {
      const count = (counts.get(sessionId) ?? 0) + 1
      counts.set(sessionId, count)
      if (count === 1) void run('ensureWatching', ensure(sessionId))
    },
    release(sessionId) {
      const remaining = (counts.get(sessionId) ?? 1) - 1
      if (remaining > 0) {
        counts.set(sessionId, remaining)
        return
      }
      counts.delete(sessionId)
      void run('stopWatching', stop(sessionId))
      onLastRelease?.(sessionId)
    },
    restart(sessionId) {
      void run('ensureWatching (post-reset)', ensure(sessionId))
    }
  }
}

export const fileExplorerWatch = createWatchRefs(
  'file watcher',
  (id) => window.refract.fileExplorer.ensureWatching(id),
  (id) => window.refract.fileExplorer.stopWatching(id)
)

export const gitChangesWatch = createWatchRefs(
  'git watcher',
  (id) => window.refract.gitChanges.ensureWatching(id),
  (id) => window.refract.gitChanges.stopWatching(id),
  (id) => useGitChangesStore.getState().forgetSession(id)
)
