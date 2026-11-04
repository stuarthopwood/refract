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
  // The anchor must be in the document: the one external-link handler listens on `document`, which a detached click never reaches.
  const anchor = document.createElement('a')
  anchor.href = ref.url
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}
