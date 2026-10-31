import { create } from 'zustand'
import type { PullRequestState } from '../../shared/github'
import { RIGHT_PANE_CONTENT_SELECTOR } from '../lib/right-pane-selectors'
import { useRightPaneStore } from './right-pane-store'

export type PinnedPanelKind = 'pull-request' | 'issue'

interface PinnedTarget {
  repositoryId: string
  number: number
  /** The Session the panel was opened from; null when opened outside a Session. */
  sessionId: string | null
  // In the store, not a ref: the header button and the panel live in different trees.
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
  /** Bumped whenever the live state is cleared; a load that began before the bump must not publish. */
  liveEpoch: number
  pin(kind: PinnedPanelKind, target: { repositoryId: string; number: number; sessionId?: string | null; opener?: HTMLElement | null }): void
  unpin(kind: PinnedPanelKind, options?: { restoreFocus?: boolean }): void
  publishPullRequestState(repositoryId: string, number: number, state: PullRequestState, epoch?: number): void
  clearLivePullRequest(): void
}

/** Per-window, never persisted: the pinned PR and issue panels follow the user across Sessions. */
export const usePinnedPanelsStore = create<PinnedPanelsState>((set, get) => ({
  pullRequest: null,
  issue: null,
  livePullRequest: null,
  liveEpoch: 0,
  pin: (kind, { repositoryId, number, sessionId = null, opener = null }) => {
    const key = kind === 'pull-request' ? 'pullRequest' : 'issue'
    const pane = useRightPaneStore.getState()
    const alreadyActive = pane.open && pane.activePanelId === kind
    const previous = get().pullRequest
    const swapped = kind === 'pull-request' && (previous?.repositoryId !== repositoryId || previous?.number !== number)
    set({
      [key]: { repositoryId, number, sessionId, opener },
      ...(swapped ? { livePullRequest: null, liveEpoch: get().liveEpoch + 1 } : {})
    } as Partial<PinnedPanelsState>)
    pane.openPanel(kind)
    // The shell only moves focus on a fresh open; a swap of the pinned item must still move it in.
    if (alreadyActive) requestAnimationFrame(() => document.querySelector<HTMLElement>(RIGHT_PANE_CONTENT_SELECTOR)?.focus())
  },
  unpin: (kind, options) => {
    const key = kind === 'pull-request' ? 'pullRequest' : 'issue'
    const opener = get()[key]?.opener ?? null
    // The live state is only fresh while the PR panel polls, so it goes with the panel.
    set({ [key]: null, ...(kind === 'pull-request' ? { livePullRequest: null, liveEpoch: get().liveEpoch + 1 } : {}) } as Partial<PinnedPanelsState>)
    if (options?.restoreFocus && opener) {
      requestAnimationFrame(() => {
        if (opener.isConnected) opener.focus()
      })
    }
  },
  publishPullRequestState: (repositoryId, number, state, epoch) => {
    const { livePullRequest: live, pullRequest: pinned, liveEpoch } = get()
    // A load that resolves after unpin, a swap or a newer readout must not resurrect stale state.
    if (epoch !== undefined && epoch !== liveEpoch) return
    if (!pinned || pinned.repositoryId !== repositoryId || pinned.number !== number) return
    if (live && live.repositoryId === repositoryId && live.number === number && live.state === state) return
    set({ livePullRequest: { repositoryId, number, state } })
  },
  clearLivePullRequest: () => set({ livePullRequest: null, liveEpoch: get().liveEpoch + 1 })
}))
