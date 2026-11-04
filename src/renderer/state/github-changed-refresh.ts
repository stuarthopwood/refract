// Quiet list refresh after `github:changed` (#1589): per list, a ~1 s debounce and at most one
// trailing run while one is in flight. A timer fires only after an event, so nothing polls.
import type { GithubChangedPayload } from '../../shared/ipc-github-changed'
import { useAccountsStore } from './accounts'
import { useHomeStore } from './home-store'
import { useIssuesStore } from './issues-store'
import { sharesActiveCountSearch, usePullRequestsStore } from './pull-requests-store'
import { useRepositoriesStore } from './repositories-store'

export const GITHUB_CHANGED_DEBOUNCE_MS = 1000

interface Lane {
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  dirty: boolean
  run: () => Promise<unknown>
}

function lane(run: () => Promise<unknown>): Lane {
  return { timer: null, running: false, dirty: false, run }
}

async function refreshPullRequests(): Promise<void> {
  const store = usePullRequestsStore.getState()
  const ids = useRepositoriesStore.getState().repositories.map((repo) => repo.id)
  if (ids.length === 0) return
  if (store.fetchedAt !== null) await store.refreshQuiet(ids)
  // The list's own search is the badge's search only on default filters; otherwise the badge needs its own fetch.
  if (store.fetchedAt === null || !sharesActiveCountSearch(usePullRequestsStore.getState(), ids)) {
    await store.refreshActiveCount(ids)
  }
}

async function refreshIssues(): Promise<void> {
  const ids = useRepositoriesStore.getState().repositories.map((repo) => repo.id)
  if (ids.length > 0 && useIssuesStore.getState().fetchedAt !== null) await useIssuesStore.getState().refreshQuiet(ids)
}

async function refreshHome(): Promise<void> {
  if (useHomeStore.getState().fetchedAt !== null) {
    await useHomeStore.getState().refresh(useRepositoriesStore.getState().repositories, true)
  }
}

const lanes = { pr: lane(refreshPullRequests), issue: lane(refreshIssues), home: lane(refreshHome) }

function fire(target: Lane): void {
  target.timer = null
  if (target.running) {
    target.dirty = true
    return
  }
  target.running = true
  void target.run().finally(() => {
    target.running = false
    if (target.dirty) {
      target.dirty = false
      fire(target)
    }
  })
}

function schedule(target: Lane): void {
  if (target.timer !== null) return
  target.timer = setTimeout(() => fire(target), GITHUB_CHANGED_DEBOUNCE_MS)
}

/** Handles one `github:changed` event; ignored until GitHub is connected. */
export function onGithubChanged(payload: GithubChangedPayload): void {
  if (useAccountsStore.getState().githubStatus !== 'ready') return
  schedule(payload.kind === 'pr' ? lanes.pr : lanes.issue)
  schedule(lanes.home)
}
