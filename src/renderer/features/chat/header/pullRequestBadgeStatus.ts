import { READOUT_CHECK_DISPLAY } from '@/features/pull-requests/check-display'
import type { PullRequestChecks, PullRequestDisplayState } from '../../../../shared/model'

/** The spoken state, with the checks folded in so the badge needs no separate focusable checks icon (#1745). */
export function pullRequestBadgeStatus(state: PullRequestDisplayState, checks: PullRequestChecks | null): string {
  return checks ? `${state}, ${READOUT_CHECK_DISPLAY[checks].label.toLowerCase()}` : state
}
