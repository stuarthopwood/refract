import * as React from 'react'
import type { PendingRequest, TranscriptItem } from '../../../shared/model'
import { AskFormCard, AskFormTimedOut } from './askForm/AskFormCard'
import { isAskTimedOut, readAskForm } from './askForm/readAskForm'
import { useAskFormOwnsFrames } from './askForm/useAskFormSession'
import { AskQuestionRow, RequestCard, ResolvedRequestSummary } from './RequestCard'
import type { ToolItem } from './TranscriptRow'

interface AskToolRowProps {
  item: ToolItem
  sessionId: string | null
  userName?: string
  userAvatarUrl?: string
  askRequestId?: string
}

/** The `ask` tool row: the combined form card while the ask runs, today's summary row otherwise. */
export function AskToolRow({ item, sessionId, userName, userAvatarUrl, askRequestId }: AskToolRowProps) {
  const fields = React.useMemo(() => readAskForm(item.args), [item.args])
  const owns = useAskFormOwnsFrames(sessionId ?? '', item.id, fields !== null)
  const running = item.status === 'running'

  if (fields && sessionId && owns) {
    if (running) return <AskFormCard sessionId={sessionId} askItemId={item.id} fields={fields} />
    if (isAskTimedOut(item.details)) return <AskFormTimedOut />
  }
  // The live question is the `request` item below, or nothing while the combined card has no form to show.
  if (running) return null
  return <AskQuestionRow item={item} userName={userName} userAvatarUrl={userAvatarUrl} requestId={askRequestId} sessionId={sessionId ?? undefined} />
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
