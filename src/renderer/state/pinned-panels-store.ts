import { create } from 'zustand'
import type { PullRequestState } from '../../shared/github'
import { useRightPaneStore } from './right-pane-store'

export type PinnedPanelKind = 'pull-request' | 'issue'

interface PinnedTarget {
  repositoryId: string
  number: number
  opener: HTMLElement | null
}

interface LivePullRequestState {
  repositoryId: string
  number: number
  state: PullRequestState
}

interface PinnedPanelsState {
  pullRequest: PinnedTarget | null
  issue: PinnedTarget | null
  /** Latest state the in-app PR view loaded, so the header badge need not wait for the readout poll. */
  livePullRequest: LivePullRequestState | null
  pin(kind: PinnedPanelKind, repositoryId: string, number: number, opener?: HTMLElement | null): void
  unpin(kind: PinnedPanelKind, options?: { restoreFocus?: boolean }): void
  publishPullRequestState(repositoryId: string, number: number, state: PullRequestState): void
}

/** Per-window, never persisted: the pinned PR and issue panels follow the user across Sessions. */
export const usePinnedPanelsStore = create<PinnedPanelsState>((set, get) => ({
  pullRequest: null,
  issue: null,
  livePullRequest: null,
  pin: (kind, repositoryId, number, opener = null) => {
    const key = kind === 'pull-request' ? 'pullRequest' : 'issue'
    const pane = useRightPaneStore.getState()
    const alreadyActive = pane.open && pane.activePanelId === kind
    set({ [key]: { repositoryId, number, opener } } as Partial<PinnedPanelsState>)
    pane.openPanel(kind)
    // The shell only moves focus on a fresh open; a swap of the pinned item must still move it in.
    if (alreadyActive) requestAnimationFrame(() => document.getElementById('right-pane-active-panel')?.focus())
  },
  unpin: (kind, options) => {
    const key = kind === 'pull-request' ? 'pullRequest' : 'issue'
    const opener = get()[key]?.opener ?? null
    // The live state is only fresh while the PR panel polls, so it goes with the panel.
    set({ [key]: null, ...(kind === 'pull-request' ? { livePullRequest: null } : {}) } as Partial<PinnedPanelsState>)
    if (options?.restoreFocus && opener) {
      requestAnimationFrame(() => {
        if (opener.isConnected) opener.focus()
      })
    }
  },
  publishPullRequestState: (repositoryId, number, state) => {
    const live = get().livePullRequest
    if (live && live.repositoryId === repositoryId && live.number === number && live.state === state) return
    set({ livePullRequest: { repositoryId, number, state } })
  }
}))
