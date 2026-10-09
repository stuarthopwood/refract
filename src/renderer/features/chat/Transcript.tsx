import * as React from 'react'
import { ArrowDownIcon, BrainIcon, Loader2Icon } from 'lucide-react'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { Button } from '@/components/ui/button'
import { cn } from 'cn'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/ui/message'
import { EMPTY_TRANSCRIPT, useChatScrollStore, usePendingRequestsStore, useSessionsStore, useSettingsStore, useTranscriptStore } from '@/state'
import { STARTUP_NOTICE_PREFIX, type PendingRequest, type TranscriptDisplaySettings, type TranscriptItem } from '../../../shared/model'
import { SCROLL_LANDING_MAX_FRAMES, SCROLL_LANDING_STABLE_FRAMES, SCROLL_PERTURBATION_TOLERANCE_PX, isAtScrollEnd, resolveLandingScrollTop } from './scrollLanding'
import { LinkContext, Markdown } from './Markdown'
import { AgentMessageRow } from './AgentMessageRow'
import { AdvisoryRow } from './AdvisoryRow'
import { CollapsedLine } from './CollapsedLine'
import { groupToolItems, isToolGroup, type GroupedTranscriptItem } from './groupToolItems'
import { ToolGroupRow, SubagentRow, toolStatusLabel } from './ToolRow'
import { AskQuestionRow, RequestCard, ResolvedRequestSummary } from './RequestCard'
import { initials } from '@/lib/initials'
import { NoticeRow } from './NoticeRow'
import { loadEarlierAnnouncement, restoreScrollTop, windowTranscriptTurns } from './windowTranscriptTurns'

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

// Issue #457: two independent Settings-driven view filters. Neither toggle ever touches main's
// `HIDDEN_TOOLS` path, which drops an item before it ever becomes a transcript row at all -- these
// act as a pure *view* filter: turning one back on restores every hidden row immediately, including
// past turns, with no reload, since the underlying `TranscriptItem[]` in the transcript store is
// never touched. Filtering the array handed to `.map()` (the render loop below) rather than hiding
// rows with CSS is what keeps a fully-hidden row out of the accessibility tree and tab order
// entirely, and is also what makes a run of now-hidden rows leave no empty gap or stray margin:
// `isFirstRow`/`previousRow` (the render loop's own gap-class bookkeeping) only ever see the rows
// that are actually rendered with real content, so a hidden (or sr-only -- see below) row can never
// become the "previous" row a later one measures its own margin against.
//
// "Never hide what needs the user or reports a problem" (issue #457): an answered/pending `ask`
// question and a `request` card both survive untouched below, since neither is a `ToolGroup` or a
// `subagent` row to begin with (`groupToolItems` never merges an `ask` call, and `request`/
// `notice`/`advisory`/`agent-message` rows are never part of either filtered kind). A `ToolGroup`
// or `subagent` row that reports a problem (an `error` or `interrupted` tool call; an `error` or
// `exited` subagent) stays `'visible'` even with "Show tool calls" off, matching
// `ChatDisplaySection.tsx`'s own copy ("failed or interrupted calls always show").
//
// Quality-gate fix (code review/a11y, Medium, round 2): EVERY hidden `thinking` item -- not only a
// non-streaming one -- is stripped from the array before `groupToolItems` runs (the turn-map render
// loop below builds `itemsForGrouping` for exactly this). A thinking part's own `streaming` flag is
// the WHOLE assistant message's flag (`src/main/omp/transcript.ts`'s `buildAssistantItems`), so it
// can still read `true` while that same message's later tool calls are already streaming in as
// `running` -- a streaming thinking item is NOT always the newest item, so keeping it in the
// grouping input (the round-1 design) could leave it sitting between two same-tool runs, merging
// them the instant the message ends and losing the later run's own expanded/focus state. `thinking`
// is therefore a plain `'visible'`/`'hidden'` toggle below; its own in-progress signal is announced
// once per assistant message (the whole message shares one `streaming` flag -- see `announceThinking`
// below), outside the grouped rows entirely (see the render loop's standalone sr-only span).
//
// Quality-gate fix (a11y, Medium, round 1): a `ToolGroup`/`subagent` row that is hidden by "Show
// tool calls" off but still ACTIVE right now (a `running` call) returns `'sr-only'` as a BASE
// candidate instead of `'hidden'` -- the render loop then promotes only the LAST such candidate in
// the turn (round 3: not simply the turn's last row by position -- a finished, hidden row can sit
// after the real running one, e.g. parallel subagents or a quick bookkeeping call that outraces a
// still-running sibling) back to `'sr-only'`, downgrading every earlier candidate to `'hidden'` (a
// group id is keyed off its first call, so a run of N sequential calls with tool calls hidden would
// otherwise unmount-and-remount a fresh `'sr-only'` row between every pair of calls, each one a new
// log addition and its own announcement -- one announcement per step, not per turn, if every
// candidate were promoted instead of only the last one), and only while that row's own turn is the
// one actually running. A visible `'sr-only'` row keeps its `MessageScrollerItem` (same key, same
// position) but swaps its content for a one-line sr-only status span naming what is running -- the
// transcript's `role="log"` gets one polite addition marking that a turn is in progress, instead of
// a user whose screen reader has no visible `TurnTotalLine` text (it is `aria-hidden` while running)
// losing every sign of life. A row that finishes without needing attention naturally falls back to
// `'hidden'`.
type RowVisibility = 'visible' | 'hidden' | 'sr-only'

function rowVisibility(row: GroupedTranscriptItem, transcriptDisplay: TranscriptDisplaySettings): RowVisibility {
  if (row.kind === 'thinking') return transcriptDisplay.thinking ? 'visible' : 'hidden'
  if (transcriptDisplay.toolCalls) return 'visible'
  if (isToolGroup(row)) {
    if (row.items.some((item) => item.status === 'error' || item.status === 'interrupted')) return 'visible'
    return row.items.some((item) => item.status === 'running') ? 'sr-only' : 'hidden'
  }
  if (row.kind === 'subagent') {
    if (row.status === 'error' || row.status === 'exited') return 'visible'
    return row.status === 'running' ? 'sr-only' : 'hidden'
  }
  return 'visible'
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
  const transcriptDisplay = useSettingsStore((state) => state.settings.transcriptDisplay)
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

  // Issue #510 slice 4 (PLAN.md row A0): "Load earlier" over the already-fully-fetched
  // transcript (see windowTranscriptTurns.ts's own doc comment) -- reset whenever this instance
  // is reused for a DIFFERENT Session (`ChatPane.tsx` swaps `sessionId` on the same `Transcript`
  // without remounting it), so a long Session's earlier reveal never leaks into the next one
  // shown in the same pane.
  const [revealedEarlier, setRevealedEarlier] = React.useState(false)
  // Quality-gate fix (cycle 2, 2026-10-08): announced once, in a polite live region that is
  // ALWAYS mounted (never created together with its own text, which screen readers generally
  // fail to announce) -- see the always-mounted `role="status"` span in the JSX below.
  const [revealedAnnouncement, setRevealedAnnouncement] = React.useState('')
  // Quality-gate fix (cycle 2, 2026-10-08): the "scroll stays put" anchor for `handleLoadEarlier`
  // below -- `scrollHeight - scrollTop` recorded just before the reveal, restored in the layout
  // effect right after the newly-revealed turns commit to the DOM (see that effect's own doc
  // comment for why a raw `scrollTop` cannot be reused directly).
  const loadEarlierAnchorRef = React.useRef<number | null>(null)
  // Quality-gate fix (a11y, cycle 3, 2026-10-08): see `handleLoadEarlier`'s own doc comment --
  // suppresses `MessageScrollerContent`'s default `role="log"` live announcements for the one
  // reveal that would otherwise flood a screen reader with every newly-visible turn at once.
  const [suppressLogAnnouncements, setSuppressLogAnnouncements] = React.useState(false)
  const { visible: visibleTurns, hiddenCount } = React.useMemo(
    () => windowTranscriptTurns(turns, revealedEarlier),
    [turns, revealedEarlier]
  )

  // Precomputes every rendered row's own top margin (docs/DESIGN.md "Transcript rhythm") and
  // every turn boundary's time-gap divider (docs/DESIGN.md "Time-gap divider") in one render pass.
  // `isFirstRow` tracks the very first rendered row across the whole transcript (no margin at
  // all, matching `gap`'s own "no space before the first child" behaviour this replaces);
  // `previousRow` is declared fresh inside each turn below, since a turn always opens with its own
  // `user` item -- never a bookkeeping kind -- so no tight-run state needs to carry across a turn
  // boundary.
  let isFirstRow = true

  // Issue #485 (spec 001 US5 acceptance scenario 3, Clarification 2026-10-06): the viewport
  // element survives both a Session switch (ChatPane.tsx swaps `sessionId` on the same
  // `Transcript` instance, no remount) and a Conversation switch (`applySnapshot` on the same
  // Session), so landing has to be driven explicitly rather than relying on `MessageScroller`'s
  // own mount-time `defaultScrollPosition`.
  const viewportRef = React.useRef<HTMLDivElement>(null)
  // Gate fixes 2 (finding 2): the settle loop's stop-on-user-input listeners (below) are
  // attached HERE, on the `MessageScroller` root, not on `viewportRef` -- the app-owned
  // "Scroll to end" `Button` (rendered below) is the viewport's OWN SIBLING,
  // not its descendant, so listeners scoped to the viewport alone never see a click (or
  // Enter/Space) on that button; a developer using it to jump to the end mid-settle had to
  // fight the loop's own re-assertion for up to `SCROLL_LANDING_MAX_FRAMES`. The root is an
  // ancestor of both the viewport and the button, and these are native `addEventListener`
  // listeners (not React synthetic ones) attached directly on that ancestor DOM node: a
  // `pointerdown`/`keydown` bubbling up from the button reaches this listener before React's
  // own event delegation (which attaches at the React root container, further up the real DOM
  // tree) ever dispatches the button's synthetic `onClick`, so an internal `stopPropagation()`
  // there could never suppress it anyway.
  const scrollerRootRef = React.useRef<HTMLDivElement>(null)
  // Finding 1 (gate fixes 4, a11y): ref to the "Scroll to end" button so the focus-restoration
  // effect below can tell whether IT currently holds focus before the button goes `inert`.
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  // Finding 6 (gate fixes 4): ref to the scrollable content so the ResizeObserver below can
  // recompute `isAtEnd` when content reflow changes `scrollHeight` without a `scroll` event.
  const contentRef = React.useRef<HTMLDivElement>(null)

  // True from the moment a Session/Conversation switch's landing effect (below) starts until it
  // has applied its own `scrollTop` -- while content-visibility rows are still being promoted
  // from their placeholder size, the browser can clamp/adjust `scrollTop` on its own (the
  // just-mounted content's placeholder-sized `scrollHeight` is smaller than the real one, so a
  // leftover `scrollTop` from the PREVIOUS Session gets silently clamped down), firing a genuine
  // `scroll` event that `handleViewportScroll` would otherwise misrecord as "the developer's
  // position" -- corrupting the very memory the landing effect is about to read. Suppressing
  // recording for this one settle window (never for real scrolling once it is over) was the
  // fix for issue #485's restore-on-return silently losing the detached position every time.
  const landingInProgressRef = React.useRef(false)

  // Mirrors `landingInProgressRef` into a real render value so `MessageScrollerProvider`'s own
  // `autoScroll` prop (below) can be turned off for the same settle window: the vendored
  // `@shadcn/react` message-scroller has its OWN scroll listener that reclassifies itself into
  // "following-bottom" mode the instant it observes the viewport within `scrollEdgeThreshold` of
  // the true bottom -- which a transient browser clamp (the race above) or even our own
  // mid-settle `scrollTop` writes can trigger for one frame even while restoring a MID-transcript
  // position. Once in that mode it re-asserts the bottom itself on every later `ResizeObserver`
  // tick a still-settling `content-visibility:auto` row fires, fighting (and eventually beating)
  // the landing effect's own re-assertion below. Disabling its `autoScroll` prop for this window
  // makes every one of its own corrective scrolls a no-op regardless of which mode it thinks it
  // is in, without touching its internal state at all. Gate-fix (quality-gate cycle 2, finding
  // 2): the vendored scroller's internal mode, once flipped to "following-bottom" (which only
  // happens while `autoScroll` is true), stays "following-bottom" until a real upward user
  // scroll clears it -- the function that clears it on demand is only ever handed to the
  // vendored `MessageScrollerViewport`'s own wheel/touch/key listeners through its internal
  // context, never exposed to application code. So turning `autoScroll` back on right after a
  // DETACHED (not-at-end) restore settles would let a still-sticky "following-bottom" mode
  // immediately re-scroll to the end on its own next render. The landing effect below therefore
  // only clears this suppression once the settled target is actually at the end; while detached
  // it stays suppressed (so the vendored scroller's mode can never even become "following-bottom"
  // in the first place) until a real scroll (`handleViewportScroll` below) brings the developer
  // back to the end themselves.
  const [autoScrollSuppressed, setAutoScrollSuppressed] = React.useState(false)
  // Gate fixes 3 (finding 3): the vendored `MessageScrollerButton`
  // ("Scroll to end") hides/disables itself from its OWN internal "mode" tracking, which only
  // ever flips out of "following-bottom" on a real user scroll upward -- a detached restore's
  // programmatic `scrollTop` write never satisfies that heuristic (the vendored mode's own
  // last-known position was the Conversation's PREVIOUS resting spot, not this restore's target,
  // so its direction-of-travel check reads the jump the wrong way round), leaving the library's
  // button permanently inert exactly when a developer far from the end most needs it (tasks.md
  // ~485 recorded data-active staying false 6000-13000px from the end). Rather than fight that
  // closed-source state machine, the button below is app-owned: `isAtEnd` is this component's own
  // measured distance-from-end, updated from the exact same `isAtScrollEnd` check already driving
  // `autoScrollSuppressed` and the scroll-memory store, so it is always correct regardless of the
  // vendored library's internal mode.
  const [isAtEnd, setIsAtEnd] = React.useState(true)

  // Raised synchronously during render -- strictly before this render's DOM commit -- so a
  // `scroll` event the browser fires from its own clamp/adjust while content-visibility rows are
  // still being promoted (the race described above) can never land while the guard still reads
  // the OLD key's value and get misrecorded against the NEW `sessionId`. A passive OR layout
  // effect both run too late to beat a clamp that happens as part of the commit itself. Reset to
  // `false` only by the landing effect below (its terminal branch, its early-user-input stop, or
  // its cleanup), never again here, so a real scroll event once landing has finished is never
  // swallowed. Tracks the previous `landingKey` with the documented "adjusting state during
  // render" pattern (a `useState` compared and updated in the render body); `setAutoScrollSuppressed`
  // and `setPrevLandingKey` both follow that sanctioned pattern.
  //
  // Gate fixes 2 (finding 4): `landingInProgressRef.current = true` on the next line is a PLAIN
  // REF MUTATION during render, which the above "quality-gate cycle 2, finding 3" comment used
  // to claim this block had moved away from entirely -- it had not; only `prevLandingKey`/
  // `autoScrollSuppressed` did, and this ref write is NOT a render-phase side effect this
  // codebase can route through `useState` instead: `handleViewportScroll` (a plain DOM-event
  // closure, not a render) must see it BEFORE the browser's own commit-time clamp/adjust can
  // fire a `scroll` event (the race described two paragraphs up) -- a `useLayoutEffect` runs
  // after commit, strictly too late to beat a clamp that happens as part of the commit itself,
  // and a reactive `useState` value read inside a plain closure would still only ever be
  // CURRENT as of the render that defined the closure, not "updated synchronously right now".
  // Accepted here as a deliberate, safe exception rather than redesigned away, for two reasons
  // specific to this renderer (verified by grep, not assumed): (1) this component tree never
  // uses `Suspense`/`startTransition`/`useTransition` (`main.tsx` wraps `<App>` in `StrictMode`
  // only), so React here never discards a render after starting it -- the one scenario where a
  // side effect during render could run against a commit that never happens; (2) `StrictMode`'s
  // dev-only double-invoke of this render body writes the exact same value (`true`) both times,
  // so it is idempotent under that double-invoke too.
  const landingKey = `${sessionId}:${transcript.generation}`
  const [prevLandingKey, setPrevLandingKey] = React.useState(landingKey)
  if (prevLandingKey !== landingKey) {
    setPrevLandingKey(landingKey)
    landingInProgressRef.current = true
    if (!autoScrollSuppressed) setAutoScrollSuppressed(true)
    // Finding 6 (gate fixes 4): resets `isAtEnd` to match the NEW Session/Conversation's own
    // stored memory immediately, in this same render-phase block -- previously it kept
    // whichever value the OLD session/generation last measured until the settle loop's
    // completion up to `SCROLL_LANDING_MAX_FRAMES` frames later, so the button could flicker or
    // lie (showing "at end" for a detached Conversation, or vice versa) for that whole window.
    const targetMemory = useChatScrollStore.getState().bySession[sessionId]
    setIsAtEnd(targetMemory === undefined || targetMemory.atEnd)
    // Quality-gate fix (cycle 2, 2026-10-08): "Load earlier"'s reveal is per Session AND per
    // Conversation (this key already covers both -- see the #510 slice 4 High finding this
    // fixes: the old plain `useEffect(() => setRevealedEarlier(false), [sessionId])` reset ran
    // AFTER commit, so the very FIRST render of an incoming Session still used the OUTGOING
    // Session's `revealedEarlier=true` and built every turn -- exactly the DOM spike the window
    // exists to avoid -- and never reset at all on a same-Session Conversation switch. Resetting
    // here, in the SAME render-phase block `isAtEnd`/`autoScrollSuppressed` already use, applies
    // before this render's own JSX is built (React restarts the render when `revealedEarlier`
    // genuinely changes), so `visibleTurns` above is already correctly windowed the first time
    // the new key is ever rendered.
    if (revealedEarlier) setRevealedEarlier(false)
    if (revealedAnnouncement) setRevealedAnnouncement('')
    // Quality-gate fix (HIGH, code review, cycle 5, 2026-10-08): a Session/Conversation switch
    // arriving between "Load earlier"'s click and the frame that would have cleared this (see
    // the dedicated effect below) must not leave the NEW Session's log permanently suppressed.
    if (suppressLogAnnouncements) setSuppressLogAnnouncements(false)
  }

  // Continuously records this Session's scroll position while the viewport is visible, so
  // whatever was last recorded is exactly where the developer left it (no separate "on leaving"
  // handler needed). Also the only place that lifts a persisted detached-restore suppression (see
  // `autoScrollSuppressed` above): once the developer scrolls back to the end themselves, the
  // vendored scroller's own follow-the-bottom behaviour is safe to re-enable.
  function handleViewportScroll(event: React.UIEvent<HTMLDivElement>) {
    if (landingInProgressRef.current) return
    const viewport = event.currentTarget
    const atEnd = isAtScrollEnd({
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight
    })
    useChatScrollStore.getState().record(sessionId, { atEnd, scrollTop: viewport.scrollTop })
    if (atEnd && autoScrollSuppressed) setAutoScrollSuppressed(false)
    setIsAtEnd(atEnd)
  }

  // Gate fixes 3 (finding 3): the app-owned "Scroll to end"
  // button's click handler. A direct `scrollTop` write (not the vendored scroller's own
  // `scrollToEnd`, which only exists inside its context and would re-engage the same stuck
  // "following-bottom" mode this button was built to route around) -- the resulting native
  // `scroll` event still reaches `handleViewportScroll` above, which records the new position
  // and clears `autoScrollSuppressed` once it reads back as at-end.
  function handleScrollToEnd() {
    const viewport = viewportRef.current
    if (!viewport) return
    const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollTop = target
    useChatScrollStore.getState().record(sessionId, { atEnd: true, scrollTop: target })
    setAutoScrollSuppressed(false)
    setIsAtEnd(true)
  }

  // Quality-gate fix (HIGH, a11y + code review, cycle 2, 2026-10-08): "Load earlier" used to
  // just flip `revealedEarlier` straight to `true`, which (1) silently jumped the view to the
  // very first (oldest) turn the instant the button -- the thing that was focused -- unmounted
  // and focus fell to `<body>`, and (2) announced nothing to a screen reader. Records the
  // anchor distance from the end BEFORE the reveal; the layout effect below restores it and
  // moves focus once the newly-revealed turns are actually in the DOM.
  function handleLoadEarlier() {
    const viewport = viewportRef.current
    loadEarlierAnchorRef.current = viewport ? viewport.scrollHeight - viewport.scrollTop : null
    setRevealedAnnouncement(loadEarlierAnnouncement(hiddenCount))
    // Quality-gate fix (a11y, cycle 3, 2026-10-08): `MessageScrollerContent` renders
    // `role="log"` by default (an implicit polite live region with `aria-relevant="additions"`),
    // so revealing up to hundreds of hidden turns at once would otherwise queue the WHOLE
    // revealed history as log-addition announcements, burying the one message that actually
    // matters. Suppressed for this one reveal only; the layout effect below clears it again
    // once the new turns have committed.
    setSuppressLogAnnouncements(true)
    setRevealedEarlier(true)
  }

  // Runs right after `handleLoadEarlier`'s reveal commits its newly-visible turns to the DOM
  // (before paint, `useLayoutEffect`, so there is no visible jump): restores the exact same
  // distance from the end the developer was at (`scrollHeight - scrollTop`, recorded before the
  // reveal) -- a raw `scrollTop` would be meaningless once thousands of pixels of newly-revealed
  // content are inserted ABOVE it, and the browser's own default scroll-anchoring is not reliable
  // here (#459's same root cause: `content-visibility:auto` rows still promoting from their
  // placeholder size). Then moves focus to the viewport itself (same target, same
  // `preventScroll` rationale, as the "Scroll to end" button's own focus-restoration effect
  // above): the clicked "Load earlier" button no longer exists once `hiddenCount` reaches zero,
  // so without this, focus would fall to `<body>` (WCAG 2.4.3, 2.4.7).
  React.useLayoutEffect(() => {
    const anchor = loadEarlierAnchorRef.current
    if (anchor === null) return
    loadEarlierAnchorRef.current = null
    const viewport = viewportRef.current
    if (viewport) {
      viewport.scrollTop = restoreScrollTop(viewport.scrollHeight, anchor)
      viewport.focus({ preventScroll: true })
    }
  }, [visibleTurns])

  // Quality-gate fix (HIGH, code review, cycle 5, 2026-10-08): pulled out of the `[visibleTurns]`
  // effect above into its own effect keyed on `suppressLogAnnouncements` itself. The previous
  // version's `requestAnimationFrame` lived inside the `[visibleTurns]` effect, so ANOTHER
  // `visibleTurns` change arriving before that frame fired (any streamed `transcript:patch`
  // during a working turn produces a new `turns`/`visibleTurns`) cancelled it on cleanup; the
  // re-run then saw `anchor === null` (already consumed by the first run) and returned early,
  // so nothing ever scheduled a replacement clear -- `suppressLogAnnouncements` stayed `true`,
  // and the transcript's `role="log"` stayed `aria-live="off"`, for the rest of the Session.
  // This effect re-arms every time `suppressLogAnnouncements` itself flips `true`, independent
  // of how many more `visibleTurns` changes land in between, and its own cleanup always cancels
  // the correct frame (including on unmount, e.g. closing this pane mid-reveal).
  React.useEffect(() => {
    if (!suppressLogAnnouncements) return
    const frame = requestAnimationFrame(() => setSuppressLogAnnouncements(false))
    return () => cancelAnimationFrame(frame)
  }, [suppressLogAnnouncements])

  // Finding 1 (gate fixes 4, a11y): the button above goes `inert` (below) the instant `isAtEnd`
  // becomes true -- both from this handler's own click AND from a Session/Conversation landing
  // (the render-phase reset above, or the settle loop's completion below) finishing at the end
  // while the button happened to be focused. `inert` pulls it out of the focus order and
  // accessibility tree immediately, which would otherwise stray focus to nowhere useful (the
  // browser drops it to `<body>`), violating WCAG 2.4.7 (focus visible), 2.4.3 (focus order),
  // and 4.1.2 (name/role/value of the currently-focused element). Moves focus to the viewport
  // itself instead, which stays focusable (`role="region" tabIndex={0}` below) across the same
  // transition -- `preventScroll` since the viewport is already exactly where it needs to be.
  // Quality-gate finding (code review, Low): `useLayoutEffect` (not the passive `useEffect` this
  // used to be) -- a passive effect runs after paint, so a rAF-driven `isAtEnd` flip (the settle
  // loop's own completion branch below, not just a click) could let the browser paint one frame
  // with focus already dropped to `<body>` by the button going `inert`, before this effect ever
  // got a chance to move it back to the viewport.
  React.useLayoutEffect(() => {
    if (!isAtEnd) return
    if (document.activeElement !== buttonRef.current) return
    viewportRef.current?.focus({ preventScroll: true })
  }, [isAtEnd])

  // Lands the viewport at the end, or restores the remembered detached position, whenever this
  // Session's transcript is wholesale-replaced (`transcript.generation`, transcript-store.ts) --
  // a Session switch, a Conversation switch, or this pane's very first mount -- never on an
  // ordinary streamed `items` update. Polls via `requestAnimationFrame`, re-applying the target
  // `scrollTop` on EVERY frame (not just once at the end): a `content-visibility:auto` row above
  // the target can keep growing `scrollHeight` after a single assignment would have landed, and
  // Chromium's own scroll-anchoring can independently nudge `scrollTop` while that growth is in
  // flight (#459's same root cause) -- a one-shot assignment loses the race either way. A long
  // transcript's settling is NOT purely a `scrollHeight`-stability question either: scroll
  // anchoring (and, while it is still catching up, `MessageScrollerProvider`'s own `autoScroll`,
  // suppressed above for this exact window) can silently overwrite `scrollTop` again in the gap
  // between two of this loop's own frames, leaving `scrollHeight` reading "stable" while the
  // position itself keeps drifting toward the bottom -- so each frame also checks whether the
  // PREVIOUS frame's own assignment actually stuck (`viewport.scrollTop` still reads what was
  // last written) and resets the counter if not, the same as a genuine height change would.
  // Bounded by `SCROLL_LANDING_MAX_FRAMES` so a layout that never truly settles cannot poll
  // forever. `useLayoutEffect` (not `useEffect`) so the first re-assertion lands before paint, in
  // the same commit as the DOM update. Gate-fix (quality-gate cycle 2, finding 1):
  // `resolveLandingScrollTop` now clamps its result to `scrollHeight - clientHeight`, matching
  // the clamp the browser itself applies to `scrollTop` -- an unclamped "land at end" target
  // could never equal the browser-clamped `viewport.scrollTop` read back afterwards, so
  // `notPerturbed` was never true and every at-end landing silently spent all
  // `SCROLL_LANDING_MAX_FRAMES` fighting a gap that was never there. The loop now also stops the
  // instant it sees real user input (wheel, keydown, pointerdown, touchstart) anywhere inside the
  // `MessageScroller` root -- the viewport itself, or the app-owned sibling "Scroll to end" button
  // (gate fixes 2, finding 2: that button lives outside `viewportRef`'s own subtree, so listeners
  // scoped to just the viewport never saw a click/Enter/Space on it, and a developer using it to
  // jump to the end mid-settle had to fight the loop's own re-assertion for up to
  // `SCROLL_LANDING_MAX_FRAMES` frames) -- a developer taking over mid-settle must not keep
  // fighting the loop's own re-assertion either way.
  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      landingInProgressRef.current = false
      setAutoScrollSuppressed(false)
      return
    }
    // Falls back to the viewport itself only if the root ref somehow is not attached yet (it is
    // always rendered as the viewport's own parent below, so this is defensive, not expected).
    const root = scrollerRootRef.current ?? viewport
    landingInProgressRef.current = true
    let cancelled = false
    let frame = 0
    let stableFrames = 0
    let lastHeight = -1
    let lastAssignedScrollTop = -1

    function removeInputListeners() {
      root.removeEventListener('wheel', handleUserInput)
      root.removeEventListener('keydown', handleKeyInput)
      root.removeEventListener('pointerdown', handleUserInput)
      root.removeEventListener('touchstart', handleUserInput)
      root.removeEventListener('focusin', handleFocusInput)
    }

    // A real wheel, key, pointer, or touch event on the viewport means the developer has taken
    // over mid-settle: stop re-asserting, clear the in-progress flag (so the normal scroll
    // handler resumes recording immediately), and record wherever they are now. `autoScroll`
    // only resumes if that position is actually at the end -- a live check (quality-gate cycle
    // 2, finding 1 re-verification) found that unconditionally clearing it here let the vendored
    // scroller's own `autoScroll` re-engage while a still-unsettled `content-visibility:auto`
    // row above was mid-collapse, overwriting a genuine upward wheel scroll caught very early in
    // the settle window; the same "only unsuppress once actually at the end" rule the normal
    // completion branch below already follows avoids that regression here too.
    function handleUserInput() {
      if (cancelled || !viewport) return
      cancelled = true
      removeInputListeners()
      const atEnd = isAtScrollEnd({
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight
      })
      useChatScrollStore.getState().record(sessionId, { atEnd, scrollTop: viewport.scrollTop })
      landingInProgressRef.current = false
      setAutoScrollSuppressed(!atEnd)
      setIsAtEnd(atEnd)
    }

    // Quality-gate remediation (round 2, 2026-10-07, a11y): the vendored scroller only reacts to
    // a handful of navigation keys itself (ArrowUp/ArrowDown/Home/End/PageUp/PageDown/Space); a
    // bare `keydown` listener here used to treat EVERY key -- Shift, Ctrl, even Ctrl+C -- as "the
    // developer took over", cancelling the landing settle loop on keystrokes that never move the
    // viewport at all. Filtered to exactly the keys the library itself moves on.
    const SCROLL_NAVIGATION_KEYS: Record<string, true> = {
      ArrowUp: true, ArrowDown: true, Home: true, End: true, PageUp: true, PageDown: true, ' ': true
    }
    function handleKeyInput(event: KeyboardEvent) {
      if (!SCROLL_NAVIGATION_KEYS[event.key]) return
      handleUserInput()
    }

    // Finding 5 (gate fixes 4, a11y): focus moving INTO the viewport mid-settle (Tab reaching a
    // focusable row, or a screen reader's virtual cursor driving `scrollIntoView`) is just as
    // much "the developer took over" as a wheel/key/pointer event -- previously only those were
    // watched, so an assistive-tech user navigating into the transcript had their own focus
    // target fought by the loop's own re-assertion for up to `SCROLL_LANDING_MAX_FRAMES` frames.
    // `focusin` bubbles (unlike `focus`), so one listener on `root` catches it from any
    // descendant; scoped to `viewport.contains(target)` so focus landing on the sibling button
    // (handled by its own click path, and by finding 1's focus-restoration effect) doesn't
    // double-trigger this.
    function handleFocusInput(event: FocusEvent) {
      if (!viewport || !viewport.contains(event.target as Node)) return
      handleUserInput()
    }

    root.addEventListener('wheel', handleUserInput, { passive: true })
    root.addEventListener('keydown', handleKeyInput, { passive: true })
    root.addEventListener('pointerdown', handleUserInput, { passive: true })
    root.addEventListener('touchstart', handleUserInput, { passive: true })
    root.addEventListener('focusin', handleFocusInput, { passive: true })

    function step() {
      if (cancelled || !viewport) return
      const { scrollHeight, clientHeight } = viewport
      const heightStable = scrollHeight === lastHeight
      const notPerturbed = lastAssignedScrollTop === -1 || Math.abs(viewport.scrollTop - lastAssignedScrollTop) < SCROLL_PERTURBATION_TOLERANCE_PX
      stableFrames = heightStable && notPerturbed ? stableFrames + 1 : 0
      lastHeight = scrollHeight
      frame += 1
      const memory = useChatScrollStore.getState().bySession[sessionId]
      const target = resolveLandingScrollTop(memory, scrollHeight, clientHeight)
      viewport.scrollTop = target
      lastAssignedScrollTop = target
      if (stableFrames >= SCROLL_LANDING_STABLE_FRAMES || frame >= SCROLL_LANDING_MAX_FRAMES) {
        cancelled = true
        removeInputListeners()
        landingInProgressRef.current = false
        // Quality-gate finding (code review, High): decided from where the viewport ACTUALLY
        // landed (the same `isAtScrollEnd` check `handleViewportScroll`/`handleUserInput` use),
        // not from `memory` directly -- a stale/incorrect memory entry (e.g. a scroll race the
        // `inFlight` guard above did not fully close, or any future call site that forgets to
        // set it) can then never leave auto-follow permanently suppressed for a Conversation
        // that is actually sitting at its end.
        const landedAtEnd = isAtScrollEnd({ scrollTop: viewport.scrollTop, scrollHeight, clientHeight })
        setAutoScrollSuppressed(!landedAtEnd)
        setIsAtEnd(landedAtEnd)
        return
      }
      requestAnimationFrame(step)
    }

    requestAnimationFrame(step)
    return () => {
      cancelled = true
      removeInputListeners()
      landingInProgressRef.current = false
    }
  }, [sessionId, transcript.generation])

  // Finding 6 (gate fixes 4): `isAtEnd` otherwise only updates from a real `scroll` event, the
  // render-phase reset above, or the settle loop's own completion -- a pane resize (e.g.
  // toggling split view) can change the viewport's `clientHeight`, and the resulting reflow can
  // change the content's `scrollHeight`, WITHOUT the browser ever firing `scroll` on either, so
  // the button could keep lying about whether the transcript is actually at its end. Observes
  // both: the viewport for `clientHeight` changes, the content for `scrollHeight` changes from
  // reflow. Skipped while a landing is in progress -- that settle loop already owns `isAtEnd`
  // for its whole window and is still re-measuring every frame regardless. Mount-once (`[]`):
  // both refs' elements survive every Session/Conversation switch (comment above `viewportRef`).
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => {
      if (landingInProgressRef.current) return
      setIsAtEnd(
        isAtScrollEnd({
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight
        })
      )
    })
    observer.observe(viewport)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    // Issue #610: the owning Session's id, read by every link/file-link renderer
    // (`Markdown.tsx`'s `a`/inline-`code`/`FileLinkButton`, `ToolRow.tsx`, `DiffView.tsx`) via
    // `LinkContext` instead of a prop threaded through that whole call chain -- set here, not in
    // `ChatPane.tsx`, so this stays clear of #621's own changes to that file.
    <LinkContext.Provider value={sessionId}>
    <MessageScrollerProvider autoScroll={!autoScrollSuppressed} defaultScrollPosition="end">
      <MessageScroller ref={scrollerRootRef} className="h-full flex-1">
        <MessageScrollerViewport
          ref={viewportRef}
          onScroll={handleViewportScroll}
          role="region"
          tabIndex={0}
          aria-label="Transcript"
          // Quality-gate finding (code review, Low): an inset ring (`ring-inset`, `outline-none`
          // on the base `focus-visible` ring instead) so the focus indicator this component's own
          // `role="region" tabIndex={0}` relies on (the focus hand-off above, and plain Tab/click
          // focus) is never clipped by this viewport's own `overflow-y-auto` + the root's
          // `overflow-hidden` ancestor -- an outer ring drawn outside the scrollable box's own
          // bounds would be cut off entirely rather than just visually tight.
          className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <MessageScrollerContent
            ref={contentRef}
            className="mx-auto w-full max-w-4xl px-4 py-4"
            // Quality-gate fix (a11y, cycle 3, 2026-10-08): this renders `role="log"` by default
            // (an implicit polite live region, `aria-relevant="additions"`) -- `off` for the one
            // frame window `handleLoadEarlier`'s reveal needs, so revealing up to hundreds of
            // hidden turns at once never queues the whole revealed history as log-addition
            // announcements. `undefined` (the log's own default) the rest of the time, so
            // ordinary streamed turns are still announced as they always were.
            aria-live={suppressLogAnnouncements ? 'off' : undefined}
          >
            {!hasConversationStarted && (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                Ready. Type a message to get started.
              </div>
            )}
            {hasConversationStarted && hiddenCount > 0 && (
              <div className="px-2 pb-2">
                <Button type="button" variant="ghost" size="sm" onClick={handleLoadEarlier}>
                  Load {hiddenCount} earlier turn{hiddenCount === 1 ? '' : 's'}
                </Button>
              </div>
            )}
            {hasConversationStarted &&
              visibleTurns.map((turn, turnIndex) => {
                const previousTurn = turnIndex > 0 ? visibleTurns[turnIndex - 1] : undefined
                const showTimeGapDivider =
                  previousTurn?.userItem != null &&
                  previousTurn.userItem.at !== 0 &&
                  turn.userItem != null &&
                  turn.userItem.at !== 0 &&
                  shouldShowTimeGapDivider(previousTurn.userItem.at, turn.userItem.at)

                let previousRow: GroupedTranscriptItem | undefined

                // Issue #457 quality-gate fix (round 2): every hidden thinking item is stripped
                // before grouping (not only a non-streaming one -- see `rowVisibility`'s own comment
                // for why a streaming one isn't safe to keep here either).
                const itemsForGrouping = transcriptDisplay.thinking
                  ? turn.items
                  : turn.items.filter((item) => item.kind !== 'thinking')

                // Quality-gate fix (round 2, corrected round 3): only one row per turn may ever
                // surface as `'sr-only'` -- a sequential run of same-tool calls would otherwise
                // unmount and remount a fresh sr-only row (a fresh id, since `groupToolItems` keys a
                // group off its first call) between every pair of calls, each one a new log addition
                // and its own announcement, one per step instead of one per turn. Round 2 picked the
                // row at the turn's own last ARRAY position, which is wrong whenever a finished,
                // already-hidden row sits after the real running one (parallel subagents; a quick
                // bookkeeping call that resolves while a sibling is still running) -- that finished
                // row isn't itself an `'sr-only'` candidate, so it was never promoted, and the real
                // running candidate earlier in the array got downgraded to `'hidden'` instead,
                // leaving no in-progress signal at all. Round 3 instead finds the LAST pair whose
                // BASE visibility is `'sr-only'` and promotes only that one; every earlier `'sr-only'`
                // candidate in the same turn downgrades to `'hidden'`. `rowVisibility` is still
                // called exactly once per row (the `.map()` below), not again later in the render.
                const isActiveTurn = turnIndex === visibleTurns.length - 1 && isTurnRunning
                const basePairs = groupToolItems(itemsForGrouping).map(
                  (row): [GroupedTranscriptItem, RowVisibility] => [row, rowVisibility(row, transcriptDisplay)]
                )
                const lastSrOnlyIndex = isActiveTurn ? basePairs.findLastIndex(([, visibility]) => visibility === 'sr-only') : -1
                const rows = basePairs
                  .map(([row, visibility], pairIndex): [GroupedTranscriptItem, RowVisibility] =>
                    visibility === 'sr-only' && pairIndex !== lastSrOnlyIndex ? [row, 'hidden'] : [row, visibility]
                  )
                  .filter(([, visibility]) => visibility !== 'hidden')

                // Quality-gate fix (a11y, round 1): a turn in progress with thinking hidden is
                // otherwise a silent gap for a screen reader (the ticking `TurnTotalLine` below is
                // `aria-hidden` while running). A thinking item's own `streaming` flag covers exactly
                // this window (round 2: `finalizeLiveTranscript` always clears it on a stop or crash,
                // so this can never get stuck on), announced once per assistant message, outside the
                // grouped rows. Round 3 (optional): skips this span when `rows` already promoted a
                // `'sr-only'` tool-group/subagent row for the same turn -- the same message's
                // `streaming` flag can cover both at once (its tool calls can already be `running`
                // while it still reads `streaming: true`), and the promoted row is the more specific
                // of the two signals, so one announcement is enough.
                const announceThinking =
                  !transcriptDisplay.thinking &&
                  turn.items.some((item) => item.kind === 'thinking' && item.streaming) &&
                  !rows.some(([, visibility]) => visibility === 'sr-only')

                return (
                  <React.Fragment key={turn.userItem?.id ?? `turn-${turnIndex}`}>
                    {showTimeGapDivider && turn.userItem != null && <TimeGapDivider at={turn.userItem.at} />}
                    {rows.map(([row, visibility]) => {
                      if (visibility === 'sr-only') {
                        // Quality-gate fix (code review/a11y, round 2): no `marginClass`, and
                        // `[content-visibility:visible] [contain-intrinsic-size:none]` overrides the
                        // base `MessageScrollerItem` class's `content-visibility:auto`/10rem
                        // placeholder reservation, so this sr-only row never shows as a blank gap and
                        // never reserves scroll height; `isFirstRow`/`previousRow` are deliberately
                        // left untouched so it can never affect a later row's own margin either.
                        return (
                          <MessageScrollerItem
                            key={row.id}
                            messageId={row.id}
                            className="[content-visibility:visible] [contain-intrinsic-size:none]"
                          >
                            {/* Quality-gate fix (round 3): no third branch -- `rowVisibility` only
                                ever returns `'sr-only'` for a `ToolGroup` or a `'subagent'` row, so a
                                row reaching here is always one of the two; a cast documents that
                                instead of a dead-code fallback the type checker can't see is
                                unreachable. */}
                            <span className="sr-only">
                              {isToolGroup(row)
                                ? `${toolStatusLabel('running')} ${row.tool}`
                                : `${toolStatusLabel('running')} subagent ${(row as Extract<GroupedTranscriptItem, { kind: 'subagent' }>).name}`}
                            </span>
                          </MessageScrollerItem>
                        )
                      }
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
                    {announceThinking && <span className="sr-only">Thinking</span>}
                    <TurnTotalLine
                      turn={turn}
                      isLastTurn={turnIndex === visibleTurns.length - 1}
                      isTurnRunning={isTurnRunning}
                      receivedAt={receivedAt}
                    />
                  </React.Fragment>
                )
              })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* Quality-gate fix (a11y, cycle 2/3, 2026-10-08): a sibling of the viewport, OUTSIDE
            `MessageScrollerContent`'s own `role="log"` -- nested inside the log, this status
            text's own insertion was itself just one more log addition (announced twice: once as
            a log addition, once as the status message). Always mounted (never created together
            with its own text, which a screen reader generally fails to announce) -- empty until
            `handleLoadEarlier` sets it. */}
        <span role="status" aria-live="polite" className="sr-only">
          {revealedAnnouncement}
        </span>
        <Button
          ref={buttonRef}
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label="Scroll to end"
          inert={isAtEnd}
          onClick={handleScrollToEnd}
          className={cn(
            "absolute inset-s-1/2 bottom-4 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground rtl:translate-x-1/2",
            isAtEnd
              ? "pointer-events-none translate-y-full scale-95 opacity-0 duration-400 ease-[cubic-bezier(0.7,0,0.84,0)]"
              : "translate-y-0 scale-100 opacity-100 ease-[cubic-bezier(0.23,1,0.32,1)]"
          )}
        >
          <ArrowDownIcon />
          <span className="sr-only">Scroll to end</span>
        </Button>
      </MessageScroller>
    </MessageScrollerProvider>
    </LinkContext.Provider>
  )
}
