import * as React from 'react'
import { BrainIcon, Loader2Icon } from 'lucide-react'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/ui/message'
import { EMPTY_TRANSCRIPT, usePendingRequestsStore, useSessionsStore, useTranscriptStore } from '@/state'
import { STARTUP_NOTICE_PREFIX, type PendingRequest, type TranscriptItem } from '../../../shared/model'
import { Markdown } from './Markdown'
import { AgentMessageRow } from './AgentMessageRow'
import { AdvisoryRow } from './AdvisoryRow'
import { CollapsedLine } from './CollapsedLine'
import { groupToolItems, isToolGroup, type GroupedTranscriptItem } from './groupToolItems'
import { ToolGroupRow, SubagentRow } from './ToolRow'
import { AskQuestionRow, RequestCard, ResolvedRequestSummary } from './RequestCard'
import { initials } from '@/lib/initials'
import { NoticeRow } from './NoticeRow'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type UserItem = Extract<TranscriptItem, { kind: 'user' }>

// Cached per repository id for the renderer's lifetime (T072, FR-045): every AskQuestionRow in
// every Session of the same repository shares one `repositories.userName` round trip.
const userNameCache = new Map<string, string>()

function useRepositoryUserName(repositoryId: string | null): string | undefined {
  const [name, setName] = React.useState<string | undefined>(repositoryId ? userNameCache.get(repositoryId) : undefined)
  React.useEffect(() => {
    if (!repositoryId) {
      setName(undefined)
      return
    }
    const cached = userNameCache.get(repositoryId)
    if (cached !== undefined) {
      setName(cached)
      return
    }
    let cancelled = false
    void window.refract.repositories.userName(repositoryId).then((result) => {
      if (cancelled || !result.ok) return
      userNameCache.set(repositoryId, result.value)
      setName(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [repositoryId])
  return name
}

function formatThinkingSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}`
}

// "28s", "1m 14s", "2h 3m" (T076, FR-046). Exported for spec 004's Turn time chip (T013), which
// must match this exact formatting.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

const THINKING_PREVIEW_CHARS = 120

/** The nearest preceding `ask` tool item for a `request` item at `requestIndex`, scanning
 * backward only until an earlier `request` item (a different question) is hit (T072/T073). */
function findPrecedingAskItem(items: TranscriptItem[], requestIndex: number): ToolItem | undefined {
  for (let i = requestIndex - 1; i >= 0; i--) {
    const candidate = items[i]!
    if (candidate.kind === 'request') break
    if (candidate.kind === 'tool' && candidate.tool === 'ask') return candidate
  }
  return undefined
}

/** Every item's own best end-time estimate, read from whichever kind-specific timing field it
 * has (T076): absent for a kind with none at all (`assistant-text`, `notice`, `request`), which
 * is exactly why `receivedAt` (live arrival time) is tried first by the caller. */
function itemEndTime(item: TranscriptItem): number | undefined {
  if (item.kind === 'tool' || item.kind === 'subagent') {
    return item.startedAt != null && item.durationMs != null ? item.startedAt + item.durationMs : undefined
  }
  if (item.kind === 'thinking') return item.endedAt
  if (item.kind === 'user' || item.kind === 'agent-message') return item.at
  return undefined
}

// Excludes the turn's own leading `user` item: its `at` always exists (even a sentinel `0` for a
// history entry with no usable timestamp, FR-046), so including it would make `computeTurnEnd`
// return a defined value for every turn and defeat the "omitted when no item carries usable
// timing" rule below -- a reopened Conversation with no real timing would show "0s" instead of
// nothing.
function computeTurnEnd(turnItems: TranscriptItem[], receivedAt: Record<string, number>): number | undefined {
  let maxEnd: number | undefined
  for (const item of turnItems) {
    if (item.kind === 'user') continue
    const end = receivedAt[item.id] ?? itemEndTime(item)
    if (end != null && (maxEnd === undefined || end > maxEnd)) maxEnd = end
  }
  return maxEnd
}

interface Turn {
  userItem: UserItem | null
  items: TranscriptItem[]
}

// Splits the flat transcript into turns (one per `user` item, running to just before the next
// one) for T076's per-turn total-time line. Any items ahead of the first `user` item (should not
// normally occur) form a leading turn with no total-time line (`userItem: null`).
function splitIntoTurns(items: TranscriptItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn = { userItem: null, items: [] }
  for (const item of items) {
    if (item.kind === 'user') {
      if (current.items.length > 0) turns.push(current)
      current = { userItem: item, items: [item] }
    } else {
      current.items.push(item)
    }
  }
  turns.push(current)
  return turns
}

interface TranscriptRowProps {
  item: GroupedTranscriptItem
  sessionId: string | null
  pending: PendingRequest[]
  userName: string | undefined
  resolvedAskByRequestId: Map<string, ToolItem | undefined>
}

// Renders one grouped transcript row per its kind (data-model.md `TranscriptItem`,
// docs/DESIGN.md "Chat"). A `request` item looks itself up in the pending-requests store: still
// pending -> RequestCard; an answered/cancelled question is superseded by the matching `ask`
// tool item once it resolves (T072/T073); a decided approval keeps its one-line summary.
function TranscriptRow({ item, sessionId, pending, userName, resolvedAskByRequestId }: TranscriptRowProps) {
  if (isToolGroup(item)) {
    return <ToolGroupRow group={item} />
  }

  switch (item.kind) {
    case 'user': {
      // Right-aligned bubble with a left indent, paired with a right-aligned avatar (docs/
      // DESIGN.md "Self vs. other layout"): `Message align="end"` reverses the row and pushes it
      // to the end; `w-fit max-w-[85%]` (replacing the old `w-full`) keeps the bubble sized to its
      // own content and caps it well short of the transcript's left edge, so it never touches it
      // regardless of message length.
      const name = userName ?? 'You'
      return (
        <Message align="end">
          <MessageAvatar aria-hidden className="text-xs font-medium">
            {initials(name)}
          </MessageAvatar>
          <MessageContent className="w-fit max-w-[85%] rounded-lg bg-accent/50 px-3 py-2">
            <MessageHeader className="px-0 text-muted-foreground">{name}</MessageHeader>
            <Markdown id={item.id} text={item.text} className="text-chat-foreground" />
          </MessageContent>
        </Message>
      )
    }

    case 'assistant-text':
      return (
        <Message>
          <MessageContent className="w-full">
            <Markdown id={item.id} text={item.text} streaming={item.streaming} className="text-chat-foreground" />
            {item.streaming && (
              <span aria-hidden className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/50 align-middle" />
            )}
          </MessageContent>
        </Message>
      )

    case 'thinking': {
      if (!item.text) return null
      const duration = item.startedAt != null && item.endedAt != null ? item.endedAt - item.startedAt : undefined
      const label = item.streaming ? 'Thinking' : duration != null ? `Thought for ${formatThinkingSeconds(duration)}s` : 'Thought'
      return (
        <CollapsedLine
          icon={
            item.streaming ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin text-state-working" />
            ) : (
              <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )
          }
          label={label}
          summary={item.streaming ? item.text.slice(-THINKING_PREVIEW_CHARS) : undefined}
        >
          {/* Dimmed to `--muted-foreground` (accessibility-auditor, round 2): the ambient
           * `--foreground` this inherited by default reads brighter than primary chat prose's own
           * `--chat-foreground`, inverting the intended secondary/bookkeeping hierarchy for a
           * Thinking block's full expanded text -- the same level its own collapsed summary above
           * already uses. */}
          <Markdown id={item.id} text={item.text} streaming={item.streaming} className="text-muted-foreground" />
        </CollapsedLine>
      )
    }

    case 'tool':
      if (item.tool === 'ask') {
        if (item.status === 'running') return null // the live question is the `request` item/RequestCard below.
        return <AskQuestionRow item={item} userName={userName} />
      }
      // Defensive fallback for a non-ask `tool` item that reaches here ungrouped (should not
      // normally occur: `groupToolItems` wraps every run, including a run of one, in a
      // `ToolGroup` before this renders). Wrapped as a one-item group so this still renders
      // through the same `ToolGroupRow` component type as the grouped path above.
      return <ToolGroupRow group={{ kind: 'tool-group', id: item.id, tool: item.tool, items: [item] }} />

    case 'subagent':
      return <SubagentRow item={item} />

    case 'agent-message':
      return <AgentMessageRow item={item} />

    case 'advisory':
      return <AdvisoryRow item={item} />

    case 'request': {
      const live = sessionId ? pending.find((request) => request.requestId === item.requestId) : undefined
      if (live && !item.resolved) {
        return <RequestCard sessionId={sessionId as string} request={live} />
      }
      if (item.resolved === 'answered' || item.resolved === 'cancelled') {
        // Superseded by the matching `ask` tool item once it resolves (T072); until then (a brief
        // race between the answer landing and that item's own `tool_execution_end`), fall back to
        // the plain one-line summary so the question is never shown as still pending.
        const askItem = resolvedAskByRequestId.get(item.id)
        if (askItem && askItem.status !== 'running') return null
      }
      return <ResolvedRequestSummary resolved={item.resolved} />
    }

    case 'notice':
      return <NoticeRow level={item.level} text={item.text} />

    default:
      return null
  }
}

interface TurnTotalLineProps {
  turn: Turn
  isLastTurn: boolean
  isTurnRunning: boolean
  receivedAt: Record<string, number>
}

// The turn's total elapsed time (T076, FR-046): a muted line after the turn's last item, `
// aria-hidden` while it is still running (ticking every second) so a screen reader only reads
// the final value once the turn ends; omitted when no item in the turn carries usable timing
// (a reopened Conversation whose history has none -- including a `user` item whose own `at` is
// the sentinel `0` fromHistory falls back to when the source message carried no timestamp at
// all, which is not a real timing and must not be used to compute an elapsed time).
function TurnTotalLine({ turn, isLastTurn, isTurnRunning, receivedAt }: TurnTotalLineProps) {
  if (!turn.userItem || turn.userItem.at === 0) return null
  const running = isLastTurn && isTurnRunning
  const end = running ? Date.now() : computeTurnEnd(turn.items, receivedAt)
  if (end === undefined) return null
  const elapsedMs = Math.max(0, end - turn.userItem.at)
  const elapsed = formatElapsed(elapsedMs)
  return (
    <div aria-hidden={running || undefined} className="mt-6 px-2 py-1 text-xs text-muted-foreground">
      {/* Visible text stays the bare minimal duration; the sr-only text adds the framing a
       * screen reader needs once this un-hides at turn end inside the transcript's `log` live
       * region, where a bare "28s" would otherwise be announced with no context. */}
      <span aria-hidden="true">{elapsed}</span>
      <span className="sr-only">Turn took {elapsed}</span>
    </div>
  )
}

// Bookkeeping rows (docs/DESIGN.md "Transcript rhythm", Stuart 2026-10-04): a run of these reads
// as compact, secondary material and must not inherit the full rhythm the turns/real messages
// around it use. Deliberately excludes an answered `ask` question (kind stays plain `tool`, never
// `tool-group` -- `groupToolItems` never merges `ask` calls) and a `request` card: both are a
// direct user<->assistant exchange, not bookkeeping, so DESIGN.md's own enumeration leaves them out.
const BOOKKEEPING_KINDS = new Set<GroupedTranscriptItem['kind']>([
  'tool-group',
  'thinking',
  'advisory',
  'notice',
  'subagent',
  'agent-message'
])

function isBookkeepingRow(row: GroupedTranscriptItem): boolean {
  return BOOKKEEPING_KINDS.has(row.kind)
}

// `MessageScrollerContent` no longer sets a uniform `gap` (see message-scroller.tsx): every row
// gets its own top margin instead, `mt-6` for the turns/real-message rhythm and `mt-1` only
// between two consecutive bookkeeping rows, computed once per render by `renderTurn` below.
const TURN_GAP_CLASS = 'mt-6'
const BOOKKEEPING_GAP_CLASS = 'mt-1'

// Time-gap divider (docs/DESIGN.md "Time-gap divider", Stuart 2026-10-04, new): shown between two
// consecutive turns that cross a calendar-day boundary, or sit more than an hour apart on the same
// day, so a resumed-the-next-day or long-running session is visible at a glance.
const TIME_GAP_THRESHOLD_MS = 60 * 60 * 1000

function shouldShowTimeGapDivider(previousAt: number, nextAt: number): boolean {
  if (new Date(previousAt).toDateString() !== new Date(nextAt).toDateString()) return true
  return nextAt - previousAt > TIME_GAP_THRESHOLD_MS
}

function TimeGapDivider({ at }: { at: number }) {
  const label = new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div role="separator" aria-label={label} className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  )
}

// The Session's transcript (T025, no props: reads the visible Session from the zustand stores).
// Follows streamed output while the user is at the bottom via shadcn Message Scroller
// (research.md decision 2: kept after a 30-tool-row streaming smoke test, see that paragraph for
// the evidence; react-virtuoso was the specced fallback if it had not held up).
export function Transcript({ sessionId }: { sessionId: string }) {
  // Spec 005: generalised from a single store-wide field to per-session storage
  // (transcript-store.ts), so each pane's own Session's items can never be dropped or
  // clobbered by the other pane's.
  const transcript = useTranscriptStore((state) => state.bySession[sessionId] ?? EMPTY_TRANSCRIPT)
  const sessions = useSessionsStore((state) => state.sessions)
  const items = transcript.items
  const receivedAt = transcript.receivedAt
  // Genuinely-empty detection (docs/DESIGN.md "Hide new-session MCP-mount dump", Stuart
  // 2026-10-04; narrowed per code/test-reviewer round 2): the only transcript item a brand-new
  // agent process can produce before any real exchange is a `notice` (OMP's own unsolicited
  // startup banner -- a `command_output`/`notice` frame, same mechanism a user-run slash
  // command's own output uses, lists every mounted MCP tool verbatim). Hiding *every* `notice`
  // until a non-notice item exists was too broad: it also hid a start-failure notice, a rejected
  // first prompt's error notice, and a slash command's own output when run as the very first
  // action in a new Session -- none of which is the startup banner, and DESIGN.md's "never a
  // silent no-op" rule for slash commands means the last of those must always be visible. A
  // `notice` now counts as "conversation started" unless it is BOTH an info/warning-level notice
  // (an error is always a real outcome, never the unsolicited banner) AND tagged
  // `STARTUP_NOTICE_PREFIX` (`transcript.ts`'s `applyFrame`, keyed off `SessionAgent.hasUserActed`
  // -- the one case that is unambiguously the agent's own startup dump, not something the user
  // did). Suppressed notice(s) stay in `items` (never dropped -- they render normally the moment
  // real content exists) but are not displayed, replaced by a neutral placeholder instead.
  const hasConversationStarted = items.some(
    (item) => item.kind !== 'notice' || item.level === 'error' || !item.id.startsWith(STARTUP_NOTICE_PREFIX)
  )
  const pendingBySession = usePendingRequestsStore((state) => state.bySession)
  const pending = pendingBySession[sessionId] ?? []

  const session = sessions.find((s) => s.id === sessionId)
  const userName = useRepositoryUserName(session?.repositoryId ?? null)
  const isTurnRunning = session?.status === 'working' || session?.status === 'needs-you'

  // Re-renders the running turn's total-time line every second (T076); the running turn is the
  // only one whose elapsed time is ever recomputed from `Date.now()` rather than frozen item
  // timestamps, so nothing else needs to re-render on this tick.
  const [, forceTick] = React.useReducer((count: number) => count + 1, 0)
  React.useEffect(() => {
    if (!isTurnRunning) return
    const interval = setInterval(forceTick, 1000)
    return () => clearInterval(interval)
  }, [isTurnRunning])

  const resolvedAskByRequestId = React.useMemo(() => {
    const map = new Map<string, ToolItem | undefined>()
    items.forEach((item, index) => {
      if (item.kind === 'request') map.set(item.id, findPrecedingAskItem(items, index))
    })
    return map
  }, [items])

  const turns = React.useMemo(() => splitIntoTurns(items), [items])

  // Precomputes every rendered row's own top margin (docs/DESIGN.md "Transcript rhythm") and
  // every turn boundary's time-gap divider (docs/DESIGN.md "Time-gap divider") in one render pass.
  // `isFirstRow` tracks the very first rendered row across the whole transcript (no margin at
  // all, matching `gap`'s own "no space before the first child" behaviour this replaces);
  // `previousRow` is declared fresh inside each turn below, since a turn always opens with its own
  // `user` item -- never a bookkeeping kind -- so no tight-run state needs to carry across a turn
  // boundary.
  let isFirstRow = true

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="h-full flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-4xl px-4 py-4">
            {!hasConversationStarted && (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                Ready. Type a message to get started.
              </div>
            )}
            {hasConversationStarted &&
              turns.map((turn, turnIndex) => {
                const previousTurn = turnIndex > 0 ? turns[turnIndex - 1] : undefined
                const showTimeGapDivider =
                  previousTurn?.userItem != null &&
                  previousTurn.userItem.at !== 0 &&
                  turn.userItem != null &&
                  turn.userItem.at !== 0 &&
                  shouldShowTimeGapDivider(previousTurn.userItem.at, turn.userItem.at)

                let previousRow: GroupedTranscriptItem | undefined

                return (
                  <React.Fragment key={turn.userItem?.id ?? `turn-${turnIndex}`}>
                    {showTimeGapDivider && turn.userItem != null && <TimeGapDivider at={turn.userItem.at} />}
                    {groupToolItems(turn.items).map((row) => {
                      const marginClass = isFirstRow
                        ? undefined
                        : previousRow && isBookkeepingRow(previousRow) && isBookkeepingRow(row)
                          ? BOOKKEEPING_GAP_CLASS
                          : TURN_GAP_CLASS
                      isFirstRow = false
                      previousRow = row
                      return (
                        <MessageScrollerItem key={row.id} messageId={row.id} className={marginClass}>
                          <TranscriptRow
                            item={row}
                            sessionId={sessionId}
                            pending={pending}
                            userName={userName}
                            resolvedAskByRequestId={resolvedAskByRequestId}
                          />
                        </MessageScrollerItem>
                      )
                    })}
                    <TurnTotalLine
                      turn={turn}
                      isLastTurn={turnIndex === turns.length - 1}
                      isTurnRunning={isTurnRunning}
                      receivedAt={receivedAt}
                    />
                  </React.Fragment>
                )
              })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
