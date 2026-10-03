import * as React from 'react'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { usePendingRequestsStore, useSessionsStore, useTranscriptStore } from '@/state'
import type { PendingRequest, TranscriptItem } from '../../../shared/model'
import { Markdown } from './Markdown'
import { ToolRow } from './ToolRow'
import { RequestCard, ResolvedRequestSummary } from './RequestCard'
import { NoticeRow } from './NoticeRow'

interface TranscriptRowProps {
  item: TranscriptItem
  sessionId: string | null
  pending: PendingRequest[]
}

// Renders one TranscriptItem per its kind (data-model.md `TranscriptItem`, docs/DESIGN.md
// "Chat"). A `request` item looks itself up in the pending-requests store: still pending ->
// RequestCard; otherwise -> the one-line resolved summary, because `TranscriptItem.resolved`
// does not carry the original request's tool/target/title once it is no longer pending.
function TranscriptRow({ item, sessionId, pending }: TranscriptRowProps) {
  switch (item.kind) {
    case 'user':
      return (
        <Message>
          <MessageContent className="w-full rounded-lg bg-accent/50 px-3 py-2">
            <MessageHeader className="px-0 text-muted-foreground">You</MessageHeader>
            <Markdown text={item.text} />
          </MessageContent>
        </Message>
      )

    case 'assistant-text':
      return (
        <Message>
          <MessageContent className="w-full">
            <Markdown text={item.text} streaming={item.streaming} />
            {item.streaming && (
              <span aria-hidden className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/50 align-middle" />
            )}
          </MessageContent>
        </Message>
      )

    case 'thinking':
      if (!item.text) return null
      return (
        <Collapsible className="rounded-md border border-border">
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted">
            Thinking
          </CollapsibleTrigger>
          <CollapsibleContent className="px-2 pb-2">
            <Markdown text={item.text} streaming={item.streaming} />
          </CollapsibleContent>
        </Collapsible>
      )

    case 'tool':
      return <ToolRow item={item} />

    case 'request': {
      const live = sessionId ? pending.find((request) => request.requestId === item.requestId) : undefined
      if (live && !item.resolved) {
        return <RequestCard sessionId={sessionId as string} request={live} />
      }
      return <ResolvedRequestSummary resolved={item.resolved} />
    }

    case 'notice':
      return <NoticeRow level={item.level} text={item.text} />
  }
}

// The Session's transcript (T025, no props: reads the visible Session from the zustand stores).
// Follows streamed output while the user is at the bottom via shadcn Message Scroller
// (research.md decision 2: kept after a 30-tool-row streaming smoke test, see that paragraph for
// the evidence; react-virtuoso was the specced fallback if it had not held up).
export function Transcript() {
  const trackedSessionId = useTranscriptStore((state) => state.sessionId)
  const storeItems = useTranscriptStore((state) => state.items)
  const visibleSessionId = useSessionsStore((state) => state.visibleSessionId)
  // The store may have adopted a `reset` for a Session that is not (yet) the visible one
  // (transcript-store.ts's defense-in-depth path for a dropped/failed `sessions.setVisible`
  // call): never render those items over the visible Session's own transcript (bug report
  // point 5's "old Session B's header/input sit over A's empty transcript").
  const items = trackedSessionId === visibleSessionId ? storeItems : []
  const pendingBySession = usePendingRequestsStore((state) => state.bySession)
  const pending = visibleSessionId ? (pendingBySession[visibleSessionId] ?? []) : []

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="h-full flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-4xl px-4 py-4">
            {items.length === 0 && (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">No messages yet</div>
            )}
            {items.map((item) => (
              <MessageScrollerItem key={item.id} messageId={item.id}>
                <TranscriptRow item={item} sessionId={visibleSessionId} pending={pending} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
