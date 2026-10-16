import * as React from 'react'
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from 'cn'
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
const STRIPE_CLASS = {
  blocker: "relative before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-severity-error before:content-['']",
  concern: "relative before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-severity-warning before:content-['']"
} as const

interface AdvisoryRowProps {
  item: AdvisoryItem
  /** Matches every other row's own optional-`sessionId` convention (`AskQuestionRow`,
   * `ResolvedRequestSummary`): the Ask-agent action simply has nothing to send to while
   * `undefined`, so it is disabled rather than throwing. */
  sessionId: string | undefined
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

// Gate round 1 fix (Security Low): the note/guidance/locations are bounded inside one clearly
// labelled `<advisory>...</advisory>` block instead of a bare `"quoted"` fragment -- the earlier
// form left the guidance, locations and advisor name outside the quotes entirely, so
// advisor-written text could end the quote early or read as the user's own instructions. Any
// literal `</advisory>` inside the advisor's own text is broken (escaped) so it can never close
// the block early.
function escapeAdvisoryDelimiter(text: string): string {
  return text.replace(/<\/advisory>/gi, '<\\/advisory>')
}

function buildAskAgentMessage(item: AdvisoryItem, locations: AdvisoryLocation[]): string {
  let payload = escapeAdvisoryDelimiter(item.text)
  if (item.guidance) {
    payload += `\n\nGuidance: ${escapeAdvisoryDelimiter(item.guidance)}`
  }
  if (locations.length) {
    payload += `\n\nLocation${locations.length > 1 ? 's' : ''}: ${locations.map((location) => location.raw).join(', ')}`
  }
  return `Please address this ${item.severity} from ${item.advisor ?? 'the advisor'}:\n\n<advisory>\n${payload}\n</advisory>`
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
// locations, no actions, the exact same plain expanded body it has always had. The blocker's own
// mount-time announcement (decision 9) moved OUT of this row entirely, into a single
// Transcript-level announcer (`useAdvisoryAnnouncement.ts`, gate round 1 High fix): a per-row
// live region nested inside the transcript's own `role="log"` double-announced a live arrival
// (once as the log's own addition, once as the nested region) and re-announced on every mount
// (Session switch, history reopen, "Load earlier").
export const AdvisoryRow = React.forwardRef<HTMLElement, AdvisoryRowProps>(function AdvisoryRow({ item, sessionId }, forwardedRef) {
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
        if (!snapshot) return
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
      // #558 decision 13: focus returns to the row's own trigger once the send completes -- but
      // only if the user has not already moved focus elsewhere during the `await` (gate round 1
      // Low fix), and without scrolling the transcript out from under them.
      if (document.activeElement === askButtonRef.current || document.activeElement === document.body) {
        innerRef.current?.focus({ preventScroll: true })
      }
    } catch (err) {
      notify({ code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setAsking(false)
    }
  }

  // Decision 14: nit gets no new treatment at all -- same plain expanded body as before.
  if (item.severity === 'nit') {
    return (
      <CollapsedLine
        icon={<Icon className={cn('size-3.5 shrink-0', className)} />}
        label={<span className={className}>{ADVISORY_WORD[item.severity]}</span>}
        summary={item.text}
        summaryClassName={className}
        meta={meta || undefined}
      >
        <div className="space-y-2">
          <div className="whitespace-pre-wrap text-sm">{item.text}</div>
          {item.guidance && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Guidance</div>
              <div className="whitespace-pre-wrap text-sm">{item.guidance}</div>
            </div>
          )}
        </div>
      </CollapsedLine>
    )
  }

  const askReasonId = `${item.id}-ask-reason`

  return (
    <div data-advisory-severity={item.severity} className={cn(item.severity === 'blocker' || open ? STRIPE_CLASS[item.severity] : undefined)}>
      <CollapsedLine
        ref={innerRef}
        icon={<Icon className={cn('size-3.5 shrink-0', className)} />}
        label={<span className={className}>{ADVISORY_WORD[item.severity]}</span>}
        summary={item.text}
        summaryClassName={className}
        meta={meta || undefined}
        open={open}
        onOpenChange={setOpen}
        contentClassName={LABEL_COLUMN_CONTENT_CLASS}
      >
        {/* Decision 2 order: note, guidance, locations, then the actions row. */}
        <div className="whitespace-pre-wrap text-sm">{item.text}</div>
        {item.guidance && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Guidance</div>
            <div className="whitespace-pre-wrap text-sm">{item.guidance}</div>
          </div>
        )}
        {locations.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{locations.length > 1 ? 'Locations' : 'Location'}</div>
            {locations.map((location) => (
              <div key={location.raw} className="select-text font-mono text-xs [overflow-wrap:anywhere]">
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
            aria-describedby={sessionUnavailable ? askReasonId : undefined}
            className={cn(COMPOSER_DISABLED_OPACITY_CLASS, COMPOSER_BUTTON_FOCUS_CLASS)}
            onClick={() => void handleAskAgent()}
          >
            Ask agent to address this {item.severity}
          </Button>
          {sessionUnavailable && (
            <span id={askReasonId} className="sr-only">
              Start the agent to send this.
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
export function AdvisoryRunRow({ group, sessionId }: AdvisoryRunRowProps) {
  const overflow = group.items.length > CONCERN_RUN_THRESHOLD
  const [showAll, setShowAll] = React.useState(false)
  const hiddenCount = group.items.length - CONCERN_RUN_THRESHOLD
  const visible = overflow && !showAll ? group.items.slice(-CONCERN_RUN_THRESHOLD) : group.items
  const firstRevealedRef = React.useRef<HTMLElement>(null)
  const wasShowAllRef = React.useRef(false)
  React.useLayoutEffect(() => {
    if (showAll && !wasShowAllRef.current) {
      firstRevealedRef.current?.focus({ preventScroll: true })
    }
    wasShowAllRef.current = showAll
  }, [showAll])
  return (
    <div className="space-y-1">
      {overflow && !showAll && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2 pt-1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-solid focus-visible:outline-ring focus-visible:ring-0"
          onClick={() => setShowAll(true)}
        >
          + Show {hiddenCount} more advisor concern{hiddenCount === 1 ? '' : 's'}
        </Button>
      )}
      {visible.map((runItem, index) => (
        <AdvisoryRow
          key={runItem.id}
          item={runItem}
          sessionId={sessionId}
          ref={overflow && showAll && index === 0 ? firstRevealedRef : undefined}
        />
      ))}
    </div>
  )
}
