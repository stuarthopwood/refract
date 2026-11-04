// Quiet list refresh after `github:changed` (#1589): per list, a ~1 s debounce, at most one trailing
// run while one is in flight, and one follow-up ~5 s after a burst's last refresh because `gh search`
// can index a merge or close late. Timers start only from an event, so nothing polls.
import type { GithubChangedPayload } from '../../shared/ipc-github-changed'
import { useAccountsStore } from './accounts'
import { useHomeStore } from './home-store'
import { useIssuesStore } from './issues-store'
import { sharesActiveCountSearch, usePullRequestsStore } from './pull-requests-store'
import { useRepositoriesStore } from './repositories-store'

export const GITHUB_CHANGED_DEBOUNCE_MS = 1000
export const GITHUB_CHANGED_FOLLOW_UP_MS = 5000

interface Lane {
  timer: ReturnType<typeof setTimeout> | null
  followUpTimer: ReturnType<typeof setTimeout> | null
  running: boolean
  dirty: boolean
  /** Resolves false when a user fetch was in flight: nothing was refreshed, so the lane reruns. */
  run: () => Promise<boolean>
}

function lane(run: () => Promise<boolean>): Lane {
  return { timer: null, followUpTimer: null, running: false, dirty: false, run }
}

/** Resolves once the store's user-driven fetch has landed. */
function untilIdle(store: {
  getState: () => { loading: boolean }
  subscribe: (listener: (state: { loading: boolean }) => void) => () => void
}): Promise<void> {
  return new Promise((resolve) => {
    if (!store.getState().loading) return resolve()
    const stop = store.subscribe((state) => {
      if (state.loading) return
      stop()
      resolve()
    })
  })
}

async function refreshPullRequests(): Promise<boolean> {
  const ids = useRepositoriesStore.getState().repositories.map((repo) => repo.id)
  if (ids.length === 0) return true
  const store = usePullRequestsStore.getState()
  const outcome = store.fetchedAt !== null ? await store.refreshQuiet(ids) : null
  if (outcome === 'deferred') {
    await untilIdle(usePullRequestsStore)
    return false
  }
  // The list's own search is the badge's search only on default filters and once it succeeded; otherwise the badge needs its own fetch.
  if (outcome === null || outcome === 'failed' || !sharesActiveCountSearch(usePullRequestsStore.getState(), ids)) {
    await store.refreshActiveCount(ids, true)
  }
  return true
}

async function refreshIssues(): Promise<boolean> {
  const ids = useRepositoriesStore.getState().repositories.map((repo) => repo.id)
  if (ids.length === 0 || useIssuesStore.getState().fetchedAt === null) return true
  if ((await useIssuesStore.getState().refreshQuiet(ids)) !== 'deferred') return true
  await untilIdle(useIssuesStore)
  return false
}

async function refreshHome(): Promise<boolean> {
  if (useHomeStore.getState().fetchedAt === null) return true
  if (await useHomeStore.getState().refresh(useRepositoriesStore.getState().repositories, true)) return true
  // Only a user Refresh in flight is worth waiting for; a quiet one already running covers this event.
  if (!useHomeStore.getState().loading) return true
  await untilIdle(useHomeStore)
  return false
}

const lanes = { pr: lane(refreshPullRequests), issue: lane(refreshIssues), home: lane(refreshHome) }

function clearFollowUp(target: Lane): void {
  if (target.followUpTimer === null) return
  clearTimeout(target.followUpTimer)
  target.followUpTimer = null
}

// One follow-up per burst: a follow-up run does not arm another, and a new event resets it.
function armFollowUp(target: Lane): void {
  clearFollowUp(target)
  if (target.timer !== null) return
  target.followUpTimer = setTimeout(() => {
    target.followUpTimer = null
    fire(target, true)
  }, GITHUB_CHANGED_FOLLOW_UP_MS)
}

function fire(target: Lane, isFollowUp = false): void {
  target.timer = null
  if (target.running) {
    target.dirty = true
    return
  }
  clearFollowUp(target)
  target.running = true
  target
    .run()
    .then((ran) => {
      if (!ran) target.dirty = true
    })
    .catch(() => {})
    .finally(() => {
      target.running = false
      if (target.dirty) {
        target.dirty = false
        fire(target)
      } else if (!isFollowUp) {
        armFollowUp(target)
      }
    })
}

function schedule(target: Lane): void {
  clearFollowUp(target)
  if (target.timer !== null) return
  target.timer = setTimeout(() => fire(target), GITHUB_CHANGED_DEBOUNCE_MS)
}

/** Handles one `github:changed` event; ignored until GitHub is connected. */
export function onGithubChanged(payload: GithubChangedPayload): void {
  if (useAccountsStore.getState().githubStatus !== 'ready') return
  schedule(payload.kind === 'pr' ? lanes.pr : lanes.issue)
  schedule(lanes.home)
}
