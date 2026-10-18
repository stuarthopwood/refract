import * as React from 'react'
import { ArrowDownIcon } from 'lucide-react'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Message, MessageContent } from '@/components/ui/message'
import { EMPTY_TRANSCRIPT, useActiveChatWidth, useChatScrollStore, usePendingRequestsStore, useSessionsStore, useSettingsStore, useTranscriptStore } from '@/state'
import { type PendingRequest, type TranscriptDisplaySettings, type TranscriptItem } from '../../../shared/model'
import { computeTurnEnd, hasNewerRealActivity } from './turnTiming'
import { isConversationStarted } from './isConversationStarted'
import { SCROLL_LANDING_MAX_FRAMES, SCROLL_LANDING_STABLE_FRAMES, SCROLL_PERTURBATION_TOLERANCE_PX, isAtScrollEnd, resolveLandingScrollTop } from './scrollLanding'
import { LinkContext, Markdown } from './Markdown'
import { AgentMessageRow } from './AgentMessageRow'
import { AdvisoryRow, AdvisoryRunRow } from './AdvisoryRow'
import { groupAdvisoryItems, isAdvisoryRun, type AdvisoryGroupedTranscriptItem } from './groupAdvisoryItems'
import { groupToolItems, isToolGroup, isThoughtRun } from './groupToolItems'
import { groupThoughtItems } from './groupThoughtItems'
import { ThoughtRunRow } from './ThoughtRunRow'
import { groupSubagentStages, isStageGroup, type StageGroup } from './groupSubagentStages'
import { StageGroupRow, SubagentChainRow } from './SubagentChainRow'
import { formatElapsed } from './formatElapsed'
import { ToolGroupRow } from './ToolRow'
import { isBookkeepingRow, rowVisibility, type RowVisibility } from './transcriptRowVisibility'
import { toolStatusLabel } from './toolStatus'
import { AskQuestionRow, RequestCard, ResolvedRequestSummary } from './RequestCard'
import { UserMessageRow, type UserItem } from './UserMessageRow'
import { NoticeRow } from './NoticeRow'
import { SkillPromptRow } from './SkillPromptRow'
import { useStageSettleAnnouncement } from './useStageSettleAnnouncement'
import { loadEarlierAnnouncement, restoreScrollTop, windowTranscriptTurns } from './windowTranscriptTurns'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

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
  item: AdvisoryGroupedTranscriptItem
  sessionId: string | null
  pending: PendingRequest[]
  userName: string | undefined; hideTime?: boolean // #555 amendment: hides a user row's own time under a directly-above TimeGapDivider (see UserMessageRowProps)
  resolvedAskByRequestId: Map<string, ToolItem | undefined> // keyed by request.requestId
  /** Both reuse EXISTING Transcript mechanisms (gate round 2/3): reveal -> suppressLogAnnouncements; queued -> revealedAnnouncement. */
  onAdvisoryReveal: () => void
  onQueuedAnnounce: (text: string) => void
}

// Renders one grouped transcript row per its kind (data-model.md `TranscriptItem`,
// docs/DESIGN.md "Chat"). A `request` item looks itself up in the pending-requests store: still
// pending -> RequestCard; an answered/cancelled question is superseded by the matching `ask`
// tool item once it resolves (T072/T073); a decided approval keeps its one-line summary.
function TranscriptRow({ item, sessionId, pending, userName, resolvedAskByRequestId, hideTime, onAdvisoryReveal, onQueuedAnnounce }: TranscriptRowProps) {
  if (isAdvisoryRun(item)) return <AdvisoryRunRow group={item} sessionId={sessionId ?? undefined} onReveal={onAdvisoryReveal} onQueuedAnnounce={onQueuedAnnounce} />
  if (isStageGroup(item)) return <StageGroupRow group={item} />
  if (isToolGroup(item)) return <ToolGroupRow group={item} />
  if (isThoughtRun(item)) return <ThoughtRunRow group={item} />

  switch (item.kind) {
    case 'user':
      // Rendering (including the per-message timestamp, issue #555) lives in `UserMessageRow` (split out to keep this file within its `check:file-size` baseline).
      return <UserMessageRow item={item} userName={userName} hideTime={hideTime} />

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

    case 'thinking':
      // Defensive fallback for a non-empty `thinking` item that reaches here ungrouped (should
      // not normally occur: `groupThoughtItems` wraps every run, including a run of one, into a
      // `ThoughtRun` before this renders -- see `groupToolItems.ts`'s own comment for why every
      // consumer downstream must never switch React element type between a lone item and a run).
      // `!item.text` matches `groupThoughtItems`'s own "dropped from grouping" rule for an empty
      // thought (defensive; Rust never actually sends one).
      if (!item.text) return null
      return <ThoughtRunRow group={{ kind: 'thought-run', id: item.id, items: [item] }} />

    case 'tool':
      if (item.tool === 'ask') {
        if (item.status === 'running') return null // the live question is the `request` item/RequestCard below.
        return <AskQuestionRow item={item} userName={userName} requestId={[...resolvedAskByRequestId].find(([, v]) => v?.id === item.id)?.[0]} sessionId={sessionId ?? undefined} />
      }
      // Defensive fallback for a non-ask `tool` item that reaches here ungrouped (should not
      // normally occur: `groupToolItems` wraps every run, including a run of one, in a
      // `ToolGroup` before this renders). Wrapped as a one-item group so this still renders
      // through the same `ToolGroupRow` component type as the grouped path above.
      return <ToolGroupRow group={{ kind: 'tool-group', id: item.id, tool: item.tool, items: [item] }} />

    case 'agent-message':
      return <AgentMessageRow item={item} />

    case 'advisory':
      return <AdvisoryRow item={item} sessionId={sessionId ?? undefined} onQueuedAnnounce={onQueuedAnnounce} />

    case 'request': {
      const live = sessionId ? pending.find((request) => request.requestId === item.requestId) : undefined
      if (live && !item.resolved) {
        return <RequestCard sessionId={sessionId as string} request={live} />
      }
      if (item.resolved === 'answered' || item.resolved === 'cancelled') {
        // Superseded by the matching `ask` tool item once it resolves (T072); until then (a brief
        // race between the answer landing and that item's own `tool_execution_end`), fall back to
        // the plain one-line summary so the question is never shown as still pending.
        const askItem = resolvedAskByRequestId.get(item.requestId)
        if (askItem && askItem.status !== 'running') return null
      }
      return <ResolvedRequestSummary resolved={item.resolved} requestId={item.requestId} sessionId={sessionId ?? undefined} />
    }

    case 'notice':
      return <NoticeRow level={item.level} text={item.text} />

    case 'skill-prompt':
      return <SkillPromptRow item={item} />

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
  // Settled is always `computeTurnEnd` (turnTiming.ts): pure/deterministic, so an unrelated
  // command's own `command_output` reply (excluded from its own scan) can never affect it no
  // matter how many times it cycles `isTurnRunning` true/false (gate round 1, live-confirmed 9s
  // -> 14s fix). `lastSettledEnd` (state, set from an effect -- never written during render)
  // remembers this turn's own last real settle so `hasNewerRealActivity` (turnTiming.ts) can
  // tell a genuine resumption (an async subagent result, an advisor follow-up, a retry after
  // compaction) apart from a bare command's own processing, which never satisfies it.
  //
  // `undefined` vs `null` (round 3 gate fix, Medium): `undefined` means "never settled yet";
  // `null` means "no settle BASELINE yet" (never a permanent block -- round 4 fix M1 below).
  // Round 4 gate fix (Main, 2026-10-18, decided: accept the rare remount-during-a-command
  // flicker rather than a frozen clock -- add to #938): H1 -- the lazy initialiser used to seed
  // `lastSettledEnd` from `settledEnd` whenever `settledEnd` was already defined, EVEN WHILE
  // still genuinely running (a remount mid-turn, `react-virtuoso` windowing or a session switch,
  // can see an already-partially-timed turn) -- that wrongly treated the turn's OWN current
  // state as its "baseline", so nothing could ever look "newer" than itself and the clock froze
  // on that value until a later item arrived. The initialiser now ignores `settledEnd` entirely
  // while `isLastTurn && isTurnRunning`: always `undefined` (ticks live via `Date.now()`
  // immediately) in that case, only seeding from `settledEnd` once genuinely not running. M1 --
  // `null` must not block ticking forever either: once `settledEnd` itself later becomes defined
  // (a genuine resumption's first real item appears) while `lastSettledEnd` is still `null`,
  // there is no prior real baseline to compare against, so ANY defined `settledEnd` is itself the
  // signal to resume ticking (a bare command's own reply can still never trigger this: its
  // notice is excluded from `computeTurnEnd` exactly as before, so `settledEnd` stays `undefined`
  // for a genuinely untimed turn regardless of how many unrelated commands run against it).
  const settledEnd = computeTurnEnd(turn.items, receivedAt)
  const [lastSettledEnd, setLastSettledEnd] = React.useState<number | null | undefined>(() =>
    isLastTurn && isTurnRunning ? undefined : (settledEnd ?? null)
  )
  React.useEffect(() => {
    if (!(isLastTurn && isTurnRunning)) setLastSettledEnd(settledEnd ?? null)
  }, [isLastTurn, isTurnRunning, settledEnd])
  if (!turn.userItem || turn.userItem.at === 0) return null
  const running =
    isLastTurn &&
    isTurnRunning &&
    (lastSettledEnd === undefined || (lastSettledEnd === null ? settledEnd !== undefined : hasNewerRealActivity(turn.items, receivedAt, lastSettledEnd)))
  const end = running ? Date.now() : settledEnd
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

// Gate round 3 a11y fix (Main, 2026-10-16): `role="separator"`+`aria-label` on the wrapper read as just "separator" on some screen readers; now a plain `div`, decorative lines stay `aria-hidden`, so the visible label reads once as plain text. `data-slot` (not a role) lets a live-check/test identify this row without re-adding an ARIA name.
function TimeGapDivider({ at }: { at: number }) {
  const label = new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div data-slot="time-gap-divider" className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
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
export function Transcript({
  sessionId,
  hasHistory,
  startNotice
}: {
  sessionId: string
  // Issue #618: whether this Session has any real history for its CURRENT Conversation thread
  // (ChatPane.tsx's own `hasHistory`, `session.currentConversation !== null`) -- a real signal,
  // unlike this component's own items-based `hasConversationStarted` below, which can read empty
  // for a Session that has real history but is still mid-snapshot-load. Gates whether "Ready…"
  // can ever show at all: a Session with history never shows it, including while it loads or
  // while its agent is starting.
  hasHistory: boolean
  // Issue #618 gate-fix (round 3), amended #672: ChatPane.tsx's own SessionStartNotice,
  // pre-built with this pane's startProgress and picked random message, rendered here --
  // centred, replacing "Ready…" for a brand-new Session, or overlaid on existing history for a
  // Session that has any. This component decides whether to dim the transcript behind it
  // (`dimTranscript` below) and clones the element with that decision (`dimmed`) so the notice
  // can back itself with a readable panel. Undefined whenever nothing is starting right now.
  startNotice?: React.ReactElement<{ dimmed?: boolean }>
}) {
  // Spec 005: generalised from a single store-wide field to per-session storage
  // (transcript-store.ts), so each pane's own Session's items can never be dropped or
  // clobbered by the other pane's.
  const transcript = useTranscriptStore((state) => state.bySession[sessionId] ?? EMPTY_TRANSCRIPT)
  const sessions = useSessionsStore((state) => state.sessions)
  const transcriptDisplay = useSettingsStore((state) => state.settings.transcriptDisplay)
  // Issue #554 (FR-073): 'reading-column' caps at 64rem, centred, transcript only.
  const chatWidth = useActiveChatWidth()
  const items = transcript.items
  const receivedAt = transcript.receivedAt
  // Genuinely-empty detection: see `isConversationStarted`'s own doc comment above (module
  // level) for the full "what counts as started" rule and why it was narrowed this way.
  const hasConversationStarted = isConversationStarted(items)
  // Issue #672: the history (if any) behind the centred start notice dims to about 40% opacity
  // while a start is in progress (gate-fix UI round 1: never non-interactive); a genuinely
  // empty Session has nothing to dim.
  const dimTranscript = Boolean(startNotice) && (hasHistory || hasConversationStarted)
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
      if (item.kind === 'request') map.set(item.requestId, findPrecedingAskItem(items, index))
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

  // Issue #563 decision 3 + gate round 2 architect addendum A: Stage boundaries key on each
  // `subagent` item's own `messageId` (groupSubagentStages.ts), not position, so "Show thinking"
  // off can drop thinking items before grouping, matching groupToolItems' pre-#457 behaviour.
  const turnsWithStages = React.useMemo(
    () =>
      visibleTurns.map((turn) => {
        const viewItems = transcriptDisplay.thinking ? turn.items : turn.items.filter((item) => item.kind !== 'thinking')
        // Issue #557: `groupThoughtItems` wraps every run of consecutive, non-empty thinking
        // items (even a run of one) into a `ThoughtRun`; order against `groupToolItems` and
        // `groupSubagentStages` does not matter, since each only rewrites items of its own kind.
        // Issue #558: `groupAdvisoryItems` runs last, over every already-grouped item in the turn.
        const groupedWithStages = groupAdvisoryItems(groupSubagentStages(groupThoughtItems(groupToolItems(viewItems))))
        return { turn, groupedWithStages, stages: groupedWithStages.filter(isStageGroup) }
      }),
    [visibleTurns, transcriptDisplay.thinking]
  )

  // Gate fix (H3): the per-Stage settle announcement lives in its own hook (file-size baseline)
  // -- the single out-of-log announcer, rendered as a sibling of `revealedAnnouncement` below.
  const stageAnnouncement = useStageSettleAnnouncement(turnsWithStages)
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
      root.removeEventListener('wheel', handleViewportPointerOrWheel)
      root.removeEventListener('keydown', handleKeyInput)
      root.removeEventListener('pointerdown', handleViewportPointerOrWheel)
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

    // Gate-fix (UI round 1, issue #672): a wheel/pointerdown on the start notice's own buttons
    // (overlaid on `viewport` below) used to bubble to `root` and cancel this landing loop --
    // scoped the same way `handleFocusInput` already is.
    function handleViewportPointerOrWheel(event: Event) {
      if (!viewport || !(event.target instanceof Node) || !viewport.contains(event.target)) return
      handleUserInput()
    }

    root.addEventListener('wheel', handleViewportPointerOrWheel, { passive: true })
    root.addEventListener('keydown', handleKeyInput, { passive: true })
    root.addEventListener('pointerdown', handleViewportPointerOrWheel, { passive: true })
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
          // bounds would be cut off entirely rather than just visually tight. Issue #672:
          // `dimTranscript` fades this to ~40% opacity behind the start notice (gate-fix UI/A11y
          // round 1: stays interactive, no `pointer-events-none`; `focus-within:opacity-100`
          // restores full strength for a focused control; no transition, so it never mid-fades).
          className={cn(
            'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            dimTranscript && 'opacity-40 focus-within:opacity-100'
          )}
        >
          <MessageScrollerContent
            ref={contentRef}
            className={cn('w-full px-4 py-4', chatWidth === 'reading-column' && 'mx-auto max-w-[64rem] px-6 @min-[40rem]:px-10 @min-[48rem]:px-14 @min-[64rem]:px-16')}
            // Quality-gate fix (a11y, cycle 3, 2026-10-08): this renders `role="log"` by default
            // (an implicit polite live region, `aria-relevant="additions"`) -- `off` for the one
            // frame window `handleLoadEarlier`'s reveal needs, so revealing up to hundreds of
            // hidden turns at once never queues the whole revealed history as log-addition
            // announcements. `undefined` (the log's own default) the rest of the time, so
            // ordinary streamed turns are still announced as they always were.
            aria-live={suppressLogAnnouncements ? 'off' : undefined}
          >
            {/* Issue #618 gate-fix (code/verif High): "Ready..." is now ALSO gated on
                `hasConversationStarted` -- `hasHistory` (ChatPane.tsx's own
                `session.currentConversation !== null`) only flips true at a settle, so a
                brand-new Session's own first turn (and the streaming reply under it) used to
                render UNDER a stale "Ready..." for the whole first turn. This is the ONLY place
                "Ready..." ever renders (a plain log addition, same as before this issue); the
                interactive `startNotice` (Keep waiting/Cancel, its own sr-only label) now
                renders OUTSIDE this role="log" entirely, as a sibling of the viewport below --
                it was being double-announced as a log addition on top of `announceStart`, and
                its buttons were focusable controls inside a live log, both already forbidden
                elsewhere in this file (see that sibling's own comment). Once neither applies the
                area is simply empty until real items load -- never a misleading "Ready..." next
                to a start in progress or an in-flight first turn. */}
            {!hasHistory && !hasConversationStarted && !startNotice && (
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
              turnsWithStages.map(({ turn, groupedWithStages, stages }, turnIndex) => {
                const previousTurn = turnIndex > 0 ? visibleTurns[turnIndex - 1] : undefined
                const showTimeGapDivider =
                  previousTurn?.userItem != null &&
                  previousTurn.userItem.at !== 0 &&
                  turn.userItem != null &&
                  turn.userItem.at !== 0 &&
                  shouldShowTimeGapDivider(previousTurn.userItem.at, turn.userItem.at)

                let previousRow: AdvisoryGroupedTranscriptItem | undefined

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
                const basePairs = groupedWithStages.map(
                  (row): [AdvisoryGroupedTranscriptItem, RowVisibility] => [row, rowVisibility(row, transcriptDisplay)]
                )
                const lastSrOnlyIndex = isActiveTurn ? basePairs.findLastIndex(([, visibility]) => visibility === 'sr-only') : -1
                const rows = basePairs
                  .map(([row, visibility], pairIndex): [AdvisoryGroupedTranscriptItem, RowVisibility] =>
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
                            {/* `rowVisibility` only ever returns `'sr-only'` for a `ToolGroup` or
                                `StageGroup` now (a bare `subagent` item can't reach here, see
                                `StageGroupedItem` in groupSubagentStages.ts) -- the final
                                `undefined` only satisfies the type checker and never renders. */}
                            <span className="sr-only">
                              {isStageGroup(row)
                                ? `${toolStatusLabel('running')} Stage ${row.stageIndex}`
                                : isToolGroup(row)
                                  ? row.items[0]!.skill
                                    ? `${toolStatusLabel('running')} skill ${row.items[0]!.skill.name}`
                                    : `${toolStatusLabel('running')} ${row.tool}`
                                  : undefined}
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
                            userName={userName} hideTime={showTimeGapDivider && row.kind === 'user'}
                            resolvedAskByRequestId={resolvedAskByRequestId}
                            onAdvisoryReveal={() => setSuppressLogAnnouncements(true)} onQueuedAnnounce={setRevealedAnnouncement}
                          />
                        </MessageScrollerItem>
                      )
                    })}
                    {announceThinking && <span className="sr-only">Thinking</span>}
                    <SubagentChainRow stages={stages} sessionId={sessionId} />
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
        {/* Issue #618 gate-fix (code/verif/a11y High), amended #672: a sibling of the viewport,
            OUTSIDE `MessageScrollerContent`'s own `role="log"` -- its sr-only label was being
            read as a second announcement on top of `announceStart`, and its Keep waiting/Cancel
            buttons were focusable controls inside a live log. `MessageScroller`'s root is
            `relative` (components/ui/message-scroller.tsx), so this overlays centred over the
            transcript area -- the empty area where "Ready..." would otherwise sit for a
            brand-new Session, or the dimmed history above (`dimTranscript`) for one that has
            any; `ChatPane.tsx` already decided whether this placement applies before ever
            passing `startNotice`. Gate-fix (UI round 1): `items-center-safe`+`overflow-y-auto`
            keep Keep waiting/Cancel reachable on a short pane; `cloneElement` passes `dimmed`
            so the notice decides whether to show its own backing panel. */}
        {startNotice && (
          <div data-start-overlay className="pointer-events-none absolute inset-0 flex items-center-safe justify-center overflow-y-auto p-2">
            <div className="pointer-events-auto">{React.cloneElement(startNotice, { dimmed: dimTranscript })}</div>
          </div>
        )}
        {/* Quality-gate fix (a11y, cycle 2/3, 2026-10-08): a sibling of the viewport, OUTSIDE
            `MessageScrollerContent`'s own `role="log"` -- nested inside the log, this status
            text's own insertion was itself just one more log addition (announced twice: once as
            a log addition, once as the status message). Always mounted (never created together
            with its own text, which a screen reader generally fails to announce) -- empty until
            `handleLoadEarlier` sets it. */}
        <span role="status" aria-live="polite" className="sr-only">
          {revealedAnnouncement}
        </span>
        <span role="status" aria-live="polite" className="sr-only">
          {stageAnnouncement}
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
