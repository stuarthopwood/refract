// React hooks over the pure stack rules (#1867): the feature gate, one pull request's position, and
// the list's position map.
import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/state'
import { useGhStackStore } from '@/state/gh-stack-store'
import type { PullRequestState } from '../../../shared/github'
import type { StackRefsResult } from '../../../shared/ipc-pull-requests'
import type { StackPosition } from '../../../shared/stack-chain'
import { buildStackMap, stackFeatureOn, stackPositionFor } from './stack-view'

const NO_POSITIONS: ReadonlyMap<string, StackPosition> = new Map()

/** On while the toggle is on and `gh stack` is `ready`; probes once if nothing has asked yet. */
export function useStackFeatureOn(): boolean {
  const settingOn = useSettingsStore((s) => s.settings.stackedPullRequests !== false)
  const state = useGhStackStore((s) => s.state)
  useEffect(() => {
    if (useGhStackStore.getState().state === null) void useGhStackStore.getState().load()
  }, [])
  return stackFeatureOn(settingOn, state)
}

/**
 * Chains one pull request against its Project's open pull requests while the toggle is on. It does
 * not wait for `ready`: the Merge dialog needs the chain to offer Install; displays gate on
 * `useStackFeatureOn`. `state` is a dependency so a merge or close re-reads the refs.
 */
export function useStackPosition(repositoryId: string, number: number, state: PullRequestState | null): StackPosition | null {
  const on = useSettingsStore((s) => s.settings.stackedPullRequests !== false)
  const [position, setPosition] = useState<StackPosition | null>(null)
  useEffect(() => {
    if (!on || state === null) {
      setPosition(null)
      return
    }
    let cancelled = false
    void window.refract.pullRequests.stackRefs(repositoryId).then((result) => {
      if (!cancelled) setPosition(result.ok ? stackPositionFor(result.value.items, number) : null)
    })
    return () => {
      cancelled = true
    }
  }, [on, repositoryId, number, state])
  return position
}

/** Chains the whole list once per load: one refs read per Project, then one pass over the rows. */
export function useStackMap(items: ReadonlyArray<{ repositoryId: string; number: number }>): ReadonlyMap<string, StackPosition> {
  const on = useStackFeatureOn()
  const [map, setMap] = useState<ReadonlyMap<string, StackPosition>>(NO_POSITIONS)
  useEffect(() => {
    if (!on || items.length === 0) {
      setMap(NO_POSITIONS)
      return
    }
    let cancelled = false
    const repositoryIds = [...new Set(items.map((item) => item.repositoryId))]
    void Promise.all(repositoryIds.map((id) => window.refract.pullRequests.stackRefs(id))).then((results) => {
      if (cancelled) return
      const refs = new Map<string, StackRefsResult['items']>()
      results.forEach((result, index) => {
        if (result.ok) refs.set(repositoryIds[index], result.value.items)
      })
      setMap(buildStackMap(items, refs))
    })
    return () => {
      cancelled = true
    }
  }, [on, items])
  return map
}
