// Issue #569 decision 1: the repository the left-nav "Pull requests" entry (spec 003 FR-001,
// T011) and its own trailing "N active" count readout (FR-032) both scope to -- the focused
// pane's Session's repository, falling back to the first added repository. Pulled out of
// `SessionList.tsx`'s own local, non-reactive `defaultRepositoryId()` (which read
// `useSplitStore.getState()` once per render) into one shared, REACTIVE source so the active-
// count effect can actually react to a real repository change (a session switch, or a split's
// focused pane changing) instead of only whatever `SessionList.tsx` happened to re-render for.
//
// Two forms, same core logic: `useDefaultRepositoryId` (a hook, for components) and
// `getDefaultRepositoryId` (a plain `.getState()` snapshot read, for the non-React store wiring
// in `init-stores.ts`'s window focus/visibility handler). Imports the three stores directly from
// their own modules, never through the `@/state` barrel: `init-stores.ts` is itself re-exported
// from that barrel, so importing the barrel here would be circular.
import { useRepositoriesStore } from '../state/repositories-store'
import { useSessionsStore } from '../state/sessions-store'
import { useSplitStore } from '../state/split-store'

function resolve(
  repositories: { id: string }[],
  sessions: { id: string; repositoryId: string }[],
  focusedSessionId: string | undefined
): string | undefined {
  const focusedSession = sessions.find((session) => session.id === focusedSessionId)
  return focusedSession?.repositoryId ?? repositories[0]?.id
}

export function useDefaultRepositoryId(): string | undefined {
  const repositories = useRepositoriesStore((state) => state.repositories)
  const sessions = useSessionsStore((state) => state.sessions)
  const focusedSessionId = useSplitStore((state) => state.paneSessionIds[state.focusedIndex] ?? state.paneSessionIds[0])
  return resolve(repositories, sessions, focusedSessionId)
}

export function getDefaultRepositoryId(): string | undefined {
  const splitState = useSplitStore.getState()
  const focusedSessionId = splitState.paneSessionIds[splitState.focusedIndex] ?? splitState.paneSessionIds[0]
  return resolve(useRepositoriesStore.getState().repositories, useSessionsStore.getState().sessions, focusedSessionId)
}
