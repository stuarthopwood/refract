import { usePinnedPanelsStore } from '@/state'
import type { TouchedRef } from '../../../../shared/model'

/** Pins registered-project items in the right pane; anything else opens in the system browser. */
export function openTouched(ref: TouchedRef, sessionId: string, opener: HTMLElement | null): void {
  if (ref.repositoryId) {
    usePinnedPanelsStore
      .getState()
      .pin(ref.kind === 'pr' ? 'pull-request' : 'issue', { repositoryId: ref.repositoryId, number: ref.number, sessionId, opener })
    return
  }
  if (!/^https?:\/\//i.test(ref.url)) return
  // A transient anchor goes through the app's one external-link handler instead of a second opener path.
  const anchor = document.createElement('a')
  anchor.href = ref.url
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'
  anchor.click()
}
