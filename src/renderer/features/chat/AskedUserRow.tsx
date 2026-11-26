import * as React from 'react'
import { AskedUserLine } from '@/components/AskedUserLine'
import { askedUserModel } from './askedUserLineAdapters'
import { useClaimAskFormFocus } from './askForm/askFormFocus'
import { useSettingsStore } from '@/state'
import type { ToolItem } from './TranscriptRow'

interface AskedUserRowProps {
  item: ToolItem
  sessionId?: string
  /** The id the live card armed its focus intent under; the row that replaces the card claims it. */
  intentId?: string
}

/** A finished `ask` or `refract_ask` row: the one Asked-user line, fed by whichever adapter reads this call (FR-139). An answered row opens by default unless the user turned that off (#1747). */
export function AskedUserRow({ item, sessionId, intentId }: AskedUserRowProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  useClaimAskFormFocus(rootRef, sessionId, intentId)
  const expandAnswered = useSettingsStore((state) => state.settings.transcriptDisplay?.expandAnsweredAsks !== false)
  const model = React.useMemo(() => askedUserModel(item), [item])
  const answered = model.status === 'answered' || model.status === 'answered-by-away'
  return <AskedUserLine model={model} ref={rootRef} defaultOpen={expandAnswered && answered} />
}
