import * as React from 'react'
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { extractAdvisoryLocations, type AdvisoryLocation } from '@/lib/advisory-locations'
import { notify, useSessionsStore } from '@/state'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { COMPOSER_BUTTON_FOCUS_CLASS, COMPOSER_DISABLED_OPACITY_CLASS } from './pickerShared'
import { CONCERN_RUN_THRESHOLD, type AdvisoryRun } from './groupAdvisoryItems'

type AdvisoryItem = Extract<TranscriptItem, { kind: 'advisory' }>

const ADVISORY_ICON = {
  blocker: OctagonAlertIcon,
  concern: TriangleAlertIcon,
  nit: InfoIcon
} as const satisfies Record<AdvisoryItem['severity'], unknown>

// Never colour alone (T080/WCAG 2.1 AA, matching `ToolRow`'s `StatusIcon`/`NoticeRow`'s own
// icon-plus-label pattern): a distinct icon shape plus the severity word below are the real cue,
// this colour just reinforces it. `blocker`/`concern` use the shared `severity-*` token classes
// (#558: CSS aliases of the same values `--destructive`/`--state-needs-you` already resolved to,
// matching `statusGlyph.ts`/`ToolRow.tsx`'s own convention -- no visual change, naming only);
// `nit` has no `--severity-nit` token and stays muted.
const ADVISORY_CLASS = {
  blocker: 'text-severity-error',
  concern: 'text-severity-warning',
  nit: 'text-muted-foreground'
} as const satisfies Record<AdvisoryItem['severity'], string>

const ADVISORY_WORD = {
  blocker: 'Blocker',
  concern: 'Concern',
  nit: 'Nit'
} as const satisfies Record<AdvisoryItem['severity'], string>

// Gate round 1 fix (Medium, layout/visual specialists): the accent bar was a permanently
// reserved `border-l-[3px]` on a local wrapper div, shifting every blocker/concern row 3px off
// the shared 24px icon grid (#565 decision 7) even while collapsed. Drawn instead as an
// absolutely-positioned `before:` pseudo-element -- zero layout impact, so the icon stays
// exactly on-grid in every state, and no `pl` compensation is needed anywhere. `before:content-
// ['']` is required for Tailwind to actually generate the pseudo-element's box.
//
// Gate round 2 fixes: (a) `before:pointer-events-none` -- the bar painted over the trigger's own
// leftmost 3px was otherwise a dead click zone; (b) `before:forced-color-adjust-none
// forced-colors:before:bg-[CanvasText]` -- OS forced-colours mode replaces an ordinary
// `background-color` with `Canvas`, making the bar invisible (severity is still carried by the
// icon and word, so this was a Medium, not a High); (c) the absolutely-positioned bar paints
// AFTER the in-flow trigger, covering the left ~2px of its inset `outline-offset-[-2px]` focus
// ring -- `[&_[data-slot=collapsible-trigger]:focus-visible]:relative …:z-[1]` lifts ONLY the
// trigger (never Copy/Ask-agent, which never sit at the wrapper's left edge) above the bar while
// it has keyboard focus, so all four sides of its ring are visible again.
const STRIPE_CLASS = {
  blocker:
    "relative before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-severity-error before:pointer-events-none before:forced-color-adjust-none before:content-[''] forced-colors:before:bg-[CanvasText] [&_[data-slot=collapsible-trigger]:focus-visible]:relative [&_[data-slot=collapsible-trigger]:focus-visible]:z-[1]",
  concern:
    "relative before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-severity-warning before:pointer-events-none before:forced-color-adjust-none before:content-[''] forced-colors:before:bg-[CanvasText] [&_[data-slot=collapsible-trigger]:focus-visible]:relative [&_[data-slot=collapsible-trigger]:focus-visible]:z-[1]"
} as const

interface AdvisoryRowProps {
  item: AdvisoryItem
  /** Matches every other row's own optional-`sessionId` convention (`AskQuestionRow`,
   * `ResolvedRequestSummary`): the Ask-agent action simply has nothing to send to while
   * `undefined`, so it is disabled rather than throwing. */
  sessionId: string | undefined
  /** Gate round 3 fix (Medium): a screen-reader user otherwise hears nothing confirming a
   * queued (not yet sent) Ask-agent -- reuses Transcript's own `revealedAnnouncement` span
   * rather than adding a new one. */
  onQueuedAnnounce: (text: string) => void
}

function buildCopyText(item: AdvisoryItem, locations: AdvisoryLocation[]): string {
  let text = `${ADVISORY_WORD[item.severity]}: ${item.text}`
  if (item.guidance) {
    text += `\n\nGuidance:\n${item.guidance}`
  }
  if (locations.length) {
    text += `\n\nLocation${locations.length > 1 ? 's' : ''}:\n${locations.map((location) => location.raw).join('\n')}`
  }
  return text
}

// Gate round 2 fix (High, three independent reviewers, live-proven): a bare `<advisory>` opening
// tag on its own line starts a CommonMark HTML block that runs to the next blank line; the
// renderer's own `Markdown` component sanitises user turns with `rehype-sanitize` and no
// `rehype-raw` (`Markdown.tsx`), so that whole block -- the note itself -- was silently dropped
// from the posted user bubble (the agent still received the full text over `chat.send`; only
// the TRANSCRIPT's own rendering misrepresented it, confirmed live, screenshot
// `01-obsidian.png`). A fenced code block is never parsed as an HTML block, so its content
// always renders verbatim; using OMP's own `<advisory>` element name for a user-authored block
// was also a second, independent reason to drop it (a model reading its own injected-advisory
// tag name back in a USER turn could misattribute authorship). The fence itself must be
// strictly longer than the longest run of backticks already inside the payload -- an
// advisor-authored run of exactly N backticks could otherwise close a fence of only N -- and the
// payload itself is capped well above any normal advisor note (an unbounded note/guidance could
// otherwise make `chat.send`'s own message body, and so this block, unboundedly large).
const MAX_ASK_AGENT_PAYLOAD_LENGTH = 8_000

function buildAskAgentMessage(item: AdvisoryItem, locations: AdvisoryLocation[]): string {
  // Gate round 3 ruling (Tests/Code): "Advisor: unknown" read as if it were a real name and
  // added noise the agent never asked for -- omit the line entirely when `item.advisor` is
  // unset, matching decision 7's own `item.advisor ?? 'the advisor'` lead-in wording, which
  // already covers the unset case without a separate placeholder line.
  let payload = item.advisor ? `Advisor: ${item.advisor}\n\n${item.text}` : item.text
  if (item.guidance) {
    payload += `\n\nGuidance: ${item.guidance}`
  }
  if (locations.length) {
    payload += `\n\nLocation${locations.length > 1 ? 's' : ''}: ${locations.map((location) => location.raw).join(', ')}`
  }
  if (payload.length > MAX_ASK_AGENT_PAYLOAD_LENGTH) {
    // Gate round 3 fix (Low): a straight `.slice(0, N)` can land mid-surrogate-pair, producing
    // an unpaired low/high surrogate in the truncated string -- back off one more character
    // when the character landing exactly on the cut boundary is a high surrogate (U+D800 to
    // U+DBFF), so the pair it starts is never split.
    const cutIndex =
      payload.charCodeAt(MAX_ASK_AGENT_PAYLOAD_LENGTH - 1) >= 0xd800 && payload.charCodeAt(MAX_ASK_AGENT_PAYLOAD_LENGTH - 1) <= 0xdbff
        ? MAX_ASK_AGENT_PAYLOAD_LENGTH - 1
        : MAX_ASK_AGENT_PAYLOAD_LENGTH
    payload = `${payload.slice(0, cutIndex)}\u2026 [truncated]`
  }
  const longestBacktickRun = (payload.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  // Gate round 3 (architect ruling): a dedicated `advisor-note` fence info string, mapped in
  // `Markdown.tsx`'s own `code` renderer to a wrapping, non-highlighted `CodeBlock` -- every
  // OTHER fence (including a plain `text` one) keeps the documented "scroll sideways only when
  // wider" rule unchanged; only this one quoted note wraps like ordinary prose.
  return `Please address this ${item.severity} from ${item.advisor ?? 'the advisor'}:\n\n${fence}advisor-note\n${payload}\n${fence}`
}

// One baseline line per `<advisory>` element OMP adds to the conversation (T085, FR-051,
// docs/DESIGN.md "Chat"): an icon shape plus the severity word (never colour alone), the advisor
// name and a "T-N" turns-ago marker when present, and a one-line preview of the note; expanding
// shows the full note and its guidance, both as plain/inert text (constitution V). A run of
// consecutive concerns (even a run of one) is always wrapped by `groupAdvisoryItems.ts` into an
// `AdvisoryRun`, rendered by `AdvisoryRunRow` below; a blocker or a nit is never part of a run.
//
// #558 (FR-051 amendment, Clarifications 2026-10-16, gate round 1 remediation): an expanded
// blocker or concern now also gets a left accent bar, any `path:line` location(s) the
// note/guidance name, a Copy action, and an "Ask agent to address this <severity>" action that
// sends the note/guidance/locations through the ordinary `chat.send` path as an ordinary user
// message, posted as a real user turn. Decision 14: a nit gets none of this -- no accent bar, no
// locations, no actions, the exact same plain expanded body it has always had.
//
// Gate round 2 fix (decision 9 amendment): the blocker's own announcement is NOT a separate
// mechanism. A gate round 1 "fix" added a single out-of-log `useAdvisoryAnnouncement` hook,
// which turned out to still re-announce on a Session/Conversation switch (the hook's own
// `seenRef` never reset) and on "Load earlier" (it read the windowed, not the full, turn list),
// and ALSO still double-read a live arrival (once via the log's own addition, once via the
// hook's own status span). Deleted entirely, matching #570's own Error line precedent: the row's
// own mount into the transcript's `role="log"` (`aria-relevant="additions"`) IS decision 9's one
// polite announcement. This is silent by construction for "Load earlier" (`suppressLogAnnouncements`
// covers the reveal frame) and for the concern-run reveal (`onReveal`, see `AdvisoryRunRow`
// below). A Session or Conversation switch DOES mount the incoming history's own rows as fresh
// log additions -- that is true of every row kind the transcript renders, not a #558-specific
// regression, so it is out of this story's scope; it fires exactly once for a genuine LIVE
// arrival, with no separate channel to double it.
export const AdvisoryRow = React.forwardRef<HTMLElement, AdvisoryRowProps>(function AdvisoryRow({ item, sessionId, onQueuedAnnounce }, forwardedRef) {
  const Icon = ADVISORY_ICON[item.severity]
  const className = ADVISORY_CLASS[item.severity]
  const meta = [item.advisor, item.turnsAgo !== undefined ? `T-${item.turnsAgo}` : undefined].filter(Boolean).join(' \u00b7 ')
  // #558 decision 9: a blocker opens by default, live or reopened from history alike -- no
  // live-vs-history branch, same rendering derived purely from the stored `severity` (matches
  // #570 decision 17's own "the same rendering, derived from stored state" precedent).
  const [open, setOpen] = React.useState(item.severity === 'blocker')
  const innerRef = React.useRef<HTMLElement>(null)
  React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLElement, [])
  const askButtonRef = React.useRef<HTMLButtonElement>(null)

  const locations = React.useMemo(() => extractAdvisoryLocations(item.text, item.guidance), [item.text, item.guidance])
  const getCopyText = React.useCallback(() => buildCopyText(item, locations), [item, locations])

  const session = useSessionsStore((state) => state.sessions.find((candidate) => candidate.id === sessionId))
  const sessionStatus = session?.status ?? 'stopped'
  // Mirrors MessageInput's own composer send-gating exactly (MessageInput.tsx:266-268): a
  // stopped Session can still send once ("not-started": `open(sessionId, true)` runs first,
  // same as a typed composer send); any OTHER stopped reason (crashed, worktree missing,
  // start failed) cannot, and a "working"/"needs-you" turn queues the message server-side.
  const notStarted = sessionStatus === 'stopped' && session?.stopReason === 'not-started'
  const sessionUnavailable = sessionStatus === 'stopped' && !notStarted
  const [asking, setAsking] = React.useState(false)
  const askDisabled = !sessionId || sessionUnavailable || asking

  async function handleAskAgent() {
    if (askDisabled || !sessionId) return
    setAsking(true)
    try {
      if (notStarted) {
        const snapshot = await useSessionsStore.getState().open(sessionId, true)
        if (!snapshot) {
          // Gate round 2 fix (Low): the composer-opening path silently gave up with no
          // feedback when a not-started Session failed to open -- the same "prompt-failed"
          // code the catch block below already uses for every other send failure.
          notify({ code: 'prompt-failed', message: 'Could not start the agent for this Session.' })
          return
        }
      }
      const message = buildAskAgentMessage(item, locations)
      // Same path a normal user message takes (`window.refract.chat.send`), so Refract's own
      // busy/queue/steer behaviour applies automatically -- it never auto-applies a fix, and
      // there is no override action, since OMP advisors have no gate to override (issue #558).
      const result = await window.refract.chat.send(sessionId, message)
      if (!result.ok) {
        // Gate round 1 fix (Medium): never surface the raw internal `agent-not-running` text
        // (mirrors side-chat-store.ts:172-176's own guard against exactly this error code).
        notify(
          result.error.code === 'agent-not-running'
            ? { code: result.error.code, message: 'The agent is not running for this Session.' }
            : result.error
        )
        return
      }
      // Gate round 3 fix (Medium, a11y): a busy turn queues this instead of sending it
      // immediately (`result.value.queued`) -- the only confirmation was a focus jump, no
      // status message at all, nothing for a screen-reader user to confirm a queued send
      // actually happened. A genuinely SENT message already gets its own confirmation from the
      // new user turn landing in the log; only the queued case needs this.
      if (result.value.queued) onQueuedAnnounce('Queued for agent')
      // #558 decision 13: focus returns to the row's own trigger once the send completes -- but
      // only if the user has not already moved focus elsewhere during the `await` (gate round 1
      // Low fix), and without scrolling the transcript out from under them.
      if (document.activeElement === askButtonRef.current || document.activeElement === document.body) {
        innerRef.current?.focus({ preventScroll: true })
      }
    } catch {
      // Gate round 2 fix (Low, layout/visual specialists): a raw thrown `err.message` could
      // surface internal detail (a stack frame, a path) the way the `agent-not-running` guard
      // just above already exists to prevent for the ordinary IPC-error path.
      notify({ code: 'prompt-failed', message: 'Could not send this to the agent.' })
    } finally {
      setAsking(false)
    }
  }

  // Decision 14: nit gets no new treatment at all -- same plain expanded body as before.
  if (item.severity === 'nit') {
    return (
      <CollapsedLine
        icon={<Icon className={cn('size-4 shrink-0', className)} />}
        label={<span className={className}>{ADVISORY_WORD[item.severity]}</span>}
        summary={item.text}
        meta={meta || undefined}
      >
        <div className="space-y-2">
          <div className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{item.text}</div>
          {item.guidance && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Guidance</div>
              <div className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{item.guidance}</div>
            </div>
          )}
        </div>
      </CollapsedLine>
    )
  }

  const askReasonId = `${item.id}-ask-reason`
  // Gate round 2 fix (Low): the sr-only disabled reason used to cover only `sessionUnavailable`
  // -- a `!sessionId` row (the ref's own doc comment above: "nothing to send to") disabled with
  // no stated reason at all.
  const askReason = !sessionId ? 'No Session to send this to.' : sessionUnavailable ? 'Start the agent to send this.' : undefined

  return (
    <div data-advisory-severity={item.severity} className={cn(item.severity === 'blocker' || open ? STRIPE_CLASS[item.severity] : undefined)}>
      <CollapsedLine
        ref={innerRef}
        icon={<Icon className={cn('size-4 shrink-0', className)} />}
        label={<span className={className}>{ADVISORY_WORD[item.severity]}</span>}
        summary={item.text}
        meta={meta || undefined}
        open={open}
        onOpenChange={setOpen}
        contentClassName={LABEL_COLUMN_CONTENT_CLASS}
      >
        {/* Decision 2 order: note, guidance, locations, then the actions row. */}
        <div className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{item.text}</div>
        {item.guidance && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Guidance</div>
            <div className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{item.guidance}</div>
          </div>
        )}
        {locations.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{locations.length > 1 ? 'Locations' : 'Location'}</div>
            {locations.map((location) => (
              <div key={location.raw} className="select-text font-code text-xs [overflow-wrap:anywhere]">
                {location.raw}
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <CopyButton getText={getCopyText} label="Copy advisory" announcement="Advisory copied" />
          <Button
            ref={askButtonRef}
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={askDisabled || undefined}
            aria-busy={asking || undefined}
            aria-describedby={askReason ? askReasonId : undefined}
            className={cn(COMPOSER_DISABLED_OPACITY_CLASS, COMPOSER_BUTTON_FOCUS_CLASS)}
            onClick={() => void handleAskAgent()}
          >
            Ask agent to address this {item.severity}
          </Button>
          {askReason && (
            <span id={askReasonId} className="sr-only">
              {askReason}
            </span>
          )}
        </div>
      </CollapsedLine>
    </div>
  )
})


interface AdvisoryRunRowProps {
  group: AdvisoryRun
  sessionId: string | undefined
  /** Gate round 2 fix (Medium, ui-architect-v3): revealing N hidden rows at once inserted every
   * one of them into the transcript's `role="log"`, with no suppression and no single summary
   * -- the same flood "Load N earlier turns" already guards against with
   * `suppressLogAnnouncements`. Reuses that exact mechanism: `Transcript.tsx` passes its own
   * setter down, so one reveal click gets one rAF-cleared suppression window instead of N
   * separate log-addition announcements. */
  onReveal?: () => void
  onQueuedAnnounce: (text: string) => void
}

/** Gate round 3 fix (High, Code/Tests/a11y): round 2's version wired the cleanup to
 * `[onFocusLost]`, a NEW function identity every render -- React tears down and re-runs an
 * effect whenever any LISTED dependency changes identity, which an inline arrow does on every
 * render, so the cleanup (and so the focus steal) fired on every ordinary re-render of an
 * overflowed run, not only a genuine unmount. Empty dependencies (`[]`) mean the cleanup fires
 * ONLY when THIS wrapper instance is truly removed from the tree; the callback itself is read
 * through a ref, updated every render, so the cleanup always calls the LATEST version without
 * needing it listed as a dependency. Applied to EVERY visible row unconditionally below (not
 * only the one at risk of overflow): round 2's conditional wrapping changed element type at the
 * overflow boundary (an `AdvisoryRow` swapping for this wrapper and back), which remounted that
 * row and dropped focus/open state on the very transition this fix exists to protect, and left
 * the FIRST row to ever overflow (five becoming six) unwrapped, with no handoff at all. Wrapping
 * every row keeps one stable element type throughout, and this component unmounting ONLY the
 * ONE row that just fell out of `visible` (a new arrival pushing the window) is the single case
 * where a sibling peer -- this same `AdvisoryRunRow` instance, including `showAllButtonRef` --
 * is still mounted to receive the handoff; a wholesale teardown (a Session switch replacing this
 * whole run with a different one, keyed differently) removes every row's wrapper AND this
 * parent's own ref together, so a flag set in that case has nothing left to call. */
function FocusHandoffOnUnmount({ onFocusLost, children }: { onFocusLost: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const onFocusLostRef = React.useRef(onFocusLost)
  onFocusLostRef.current = onFocusLost
  React.useLayoutEffect(() => {
    return () => {
      if (ref.current?.contains(document.activeElement)) onFocusLostRef.current()
    }
  }, [])
  return <div ref={ref}>{children}</div>
}

// #558 decision 10 (gate round 1: always-wrap, see `groupAdvisoryItems.ts`'s own comment): a
// run of `CONCERN_RUN_THRESHOLD` or fewer renders every row with no control at all -- visually
// identical to the pre-#558, never-grouped behaviour. A run longer than that shows only the
// newest `CONCERN_RUN_THRESHOLD`, behind a one-way "+ Show N more advisor concerns" reveal
// placed ABOVE the rows (gate round 1, ui-architect-v3 final call: hidden rows are OLDER, the
// same reading-order "Load N earlier turns" already uses). Activating it moves focus, in a
// `useLayoutEffect`, to the first newly revealed (oldest) row's own trigger (gate round 1 High
// fix: the button used to simply unmount, dropping focus to `<body>`, the same defect "Load N
// earlier turns" was fixed for in this same file, Transcript.tsx:609-646).
export function AdvisoryRunRow({ group, sessionId, onReveal, onQueuedAnnounce }: AdvisoryRunRowProps) {
  const overflow = group.items.length > CONCERN_RUN_THRESHOLD
  const [showAll, setShowAll] = React.useState(false)
  const hiddenCount = group.items.length - CONCERN_RUN_THRESHOLD
  const visible = overflow && !showAll ? group.items.slice(-CONCERN_RUN_THRESHOLD) : group.items
  const firstRevealedRef = React.useRef<HTMLElement>(null)
  const showAllButtonRef = React.useRef<HTMLButtonElement>(null)
  const wasShowAllRef = React.useRef(false)
  const focusLostToOverflowRef = React.useRef(false)
  React.useLayoutEffect(() => {
    if (showAll && !wasShowAllRef.current) {
      firstRevealedRef.current?.focus({ preventScroll: true })
    }
    wasShowAllRef.current = showAll
  }, [showAll])
  // Gate round 2 fix (Medium, M2): a sixth consecutive concern hides the oldest of the newest
  // five behind the reveal above -- if the user's focus was inside that row (its trigger, Copy
  // or Ask-agent), it must move to the reveal button, never fall to `<body>` (the same "no focus
  // on `<body>` after any unmount" rule "Load N earlier turns" and the first fix above follow).
  React.useLayoutEffect(() => {
    if (focusLostToOverflowRef.current) {
      focusLostToOverflowRef.current = false
      showAllButtonRef.current?.focus({ preventScroll: true })
    }
  })
  const handleFocusLost = React.useCallback(() => {
    focusLostToOverflowRef.current = true
  }, [])
  return (
    <div className="space-y-1">
      {overflow && !showAll && (
        <Button
          ref={showAllButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          className="px-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-solid focus-visible:outline-ring focus-visible:ring-0"
          onClick={() => {
            onReveal?.()
            setShowAll(true)
          }}
        >
          <span aria-hidden="true">+</span> Show {hiddenCount} more advisor concern{hiddenCount === 1 ? '' : 's'}
        </Button>
      )}
      {visible.map((runItem, index) => (
        <FocusHandoffOnUnmount key={runItem.id} onFocusLost={handleFocusLost}>
          <AdvisoryRow
            item={runItem}
            sessionId={sessionId}
            onQueuedAnnounce={onQueuedAnnounce}
            ref={overflow && showAll && index === 0 ? firstRevealedRef : undefined}
          />
        </FocusHandoffOnUnmount>
      ))}
    </div>
  )
}
