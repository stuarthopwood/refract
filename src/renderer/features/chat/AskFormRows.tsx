import * as React from 'react'
import type { PendingRequest, TranscriptItem } from '../../../shared/model'
import { AskFormCard } from './askForm/AskFormCard'
import { readAskForm } from './askForm/readAskForm'
import { useAskFormOwnsFrames } from './askForm/useAskFormSession'
import { AskedUserRow } from './AskedUserRow'
import { RequestCard, ResolvedRequestSummary } from './RequestCard'
import type { ToolItem } from './TranscriptRow'

interface AskToolRowProps {
  item: ToolItem
  sessionId: string | null
  askRequestId?: string
}

/** The `ask` tool row: the combined form card while the ask runs, the Asked-user line once it has finished. */
export function AskToolRow({ item, sessionId, askRequestId }: AskToolRowProps) {
  const fields = React.useMemo(() => readAskForm(item.args), [item.args])
  const owns = useAskFormOwnsFrames(sessionId ?? '', item.id, fields !== null)
  const running = item.status === 'running'

  const formOwned = fields !== null && sessionId !== null && owns
  if (formOwned && running) return <AskFormCard sessionId={sessionId} askItemId={item.id} fields={fields} />
  // The live question is the `request` item below, or nothing while the combined card has no form to show.
  if (running) return null
  // A form's live card arms its focus intent under the ask item id, so the row that replaces it claims that key.
  return <AskedUserRow item={item} sessionId={sessionId ?? undefined} intentId={fields ? item.id : askRequestId} />
}

interface RequestItemRowProps {
  item: Extract<TranscriptItem, { kind: 'request' }>
  sessionId: string | null
  pending: PendingRequest[]
  resolvedAsk?: ToolItem
}

/** A `request` row; the frames of an ask the combined card owns render nothing, and fall back to per-field cards on a mismatch. */
export function RequestItemRow({ item, sessionId, pending, resolvedAsk }: RequestItemRowProps) {
  const hasForm = React.useMemo(() => resolvedAsk !== undefined && readAskForm(resolvedAsk.args) !== null, [resolvedAsk])
  const owned = useAskFormOwnsFrames(sessionId ?? '', resolvedAsk?.id, hasForm)
  if (owned) return null

  const live = sessionId ? pending.find((request) => request.requestId === item.requestId) : undefined
  if (live && !item.resolved) {
    return <RequestCard sessionId={sessionId as string} request={live} />
  }
  if (item.resolved === 'answered' || item.resolved === 'cancelled') {
    // Superseded by the matching `ask` tool item once it resolves (T072); until then (a brief
    // race between the answer landing and that item's own `tool_execution_end`), fall back to
    // the plain one-line summary so the question is never shown as still pending.
    if (resolvedAsk && resolvedAsk.status !== 'running') return null
  }
  return <ResolvedRequestSummary resolved={item.resolved} requestId={item.requestId} sessionId={sessionId ?? undefined} />
}
