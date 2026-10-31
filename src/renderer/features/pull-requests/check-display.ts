import { CheckCircle2Icon, CircleDashedIcon, LoaderCircleIcon, XCircleIcon } from 'lucide-react'
import type { PullRequestChecks } from '../../../shared/model'
import type { PullRequestSummary } from '../../../shared/github'
import type { ComponentType } from 'react'

export interface CheckDisplay {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  label: string
}

export interface CheckStateDisplay extends CheckDisplay {
  /** Severity colour on icon and label (#1121); `none` keeps `text-muted-foreground`. */
  colorClass: string
}

/** Every non-`none` check state carries its own severity colour on icon and label (#1121); `none` stays muted. */
export const CHECK_STATE_DISPLAY: Record<PullRequestSummary['checkState'], CheckStateDisplay> = {
  passed: { icon: CheckCircle2Icon, label: 'Checks passed', colorClass: 'text-severity-success' },
  failed: { icon: XCircleIcon, label: 'Checks failed', colorClass: 'text-severity-error' },
  pending: { icon: LoaderCircleIcon, label: 'Checks running', colorClass: 'text-severity-warning' },
  none: { icon: CircleDashedIcon, label: 'No checks', colorClass: 'text-muted-foreground' }
}

/** The same displays keyed by the Session readout's check vocabulary. */
export const READOUT_CHECK_DISPLAY: Record<PullRequestChecks, CheckStateDisplay> = {
  pass: CHECK_STATE_DISPLAY.passed,
  fail: CHECK_STATE_DISPLAY.failed,
  pending: CHECK_STATE_DISPLAY.pending
}
