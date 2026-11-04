import { CircleCheckIcon, CircleDotIcon, CircleHelpIcon } from 'lucide-react'
import type { TouchedRef } from '../../../../shared/model'

/** State icon for an issue; a superset state type so linked issues and touched refs share it. */
export function IssueIcon({ state }: { state: TouchedRef['state'] }) {
  const Icon = state === 'closed' ? CircleCheckIcon : state === 'unknown' ? CircleHelpIcon : CircleDotIcon
  return <Icon aria-hidden className="size-4" />
}
