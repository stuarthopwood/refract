import * as React from 'react'
import { AskedUserLine } from '@/components/AskedUserLine'
import { askedUserModel } from './askedUserLineAdapters'
import { useClaimAskFormFocus } from './askForm/askFormFocus'
import type { ToolItem } from './TranscriptRow'

interface AskedUserRowProps {
  item: ToolItem
  sessionId?: string
  /** The id the live card armed its focus intent under; the row that replaces the card claims it. */
  intentId?: string
}

/** A finished `ask` or `refract_ask` row: the one Asked-user line, fed by whichever adapter reads this call (FR-139). */
export function AskedUserRow({ item, sessionId, intentId }: AskedUserRowProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  useClaimAskFormFocus(rootRef, sessionId, intentId)
  const model = React.useMemo(() => askedUserModel(item), [item])
  return <AskedUserLine model={model} ref={rootRef} />
}
