import * as React from 'react'
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { extractAdvisoryLocations } from '@/lib/advisory-locations'
import { notify } from '@/state'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import type { AdvisoryRun } from './groupAdvisoryItems'

type AdvisoryItem = Extract<TranscriptItem, { kind: 'advisory' }>

const ADVISORY_ICON = {
  blocker: OctagonAlertIcon,
  concern: TriangleAlertIcon,
  nit: InfoIcon
} as const satisfies Record<AdvisoryItem['severity'], unknown>

// Never colour alone (T080/WCAG 2.1 AA, matching `ToolRow`'s `StatusIcon`/`NoticeRow`'s own
// icon-plus-label pattern): a distinct icon shape plus the severity word below are the real cue,
// this colour just reinforces it. `blocker`/`concern` use the shared `severity-*` token classes
// (#558, gate round: CSS aliases of the same values `--destructive`/`--state-needs-you` already
// resolved to, matching `statusGlyph.ts`/`ToolRow.tsx`'s own convention -- no visual change,
// naming only); `nit` has no `--severity-nit` token and stays muted.
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

// #558 decision 1: the 3px left accent bar is a LOCAL wrapper around this row's own output
// (never a `CollapsedLine` prop) -- matching every existing left-accent instance in the app
// (`ConversationSwitcher.tsx`, `SlashMenu.tsx`, `pickerShared.tsx`, `ManageAccountsDialog.tsx`),
// each a sibling class on that component's own root, never a shared-primitive prop.
const ACCENT_CLASS = {
  blocker: 'border-l-severity-error',
  concern: 'border-l-severity-warning'
} as const

interface AdvisoryRowProps {
  item: AdvisoryItem
  /** Matches every other row's own optional-`sessionId` convention (`AskQuestionRow`,
   * `ResolvedRequestSummary`): the Ask-agent action simply has nothing to send to while
   * `undefined`, so it is disabled rather than throwing. */
  sessionId: string | undefined
}

// One baseline line per `<advisory>` element OMP adds to the conversation (T085, FR-051,
// docs/DESIGN.md "Chat"): an icon shape plus the severity word (never colour alone), the advisor
// name and a "T-N" turns-ago marker when present, and a one-line preview of the note; expanding
// shows the full note and its guidance, both as plain/inert text (constitution V). Never grouped
// (`groupToolItems` only ever sees `tool` items) -- except a long run of plain CONCERNS, folded
// by `groupAdvisoryItems.ts`/`AdvisoryRunRow.tsx`, which this component is unaware of -- and
// never hidden.
//
// #558 (FR-051 amendment, Clarifications 2026-10-16): an expanded blocker or concern now also
// gets a left accent bar, any `path:line` location(s) the note/guidance name, a Copy action, and
// an "Ask agent to address this <severity>" action that sends the note/guidance/locations
// through the ordinary `chat.send` path as ordinary user message, posted as a real user turn.
// Decision 14: a nit gets none of this -- no accent bar, no locations, no actions, the exact
// same plain expanded body it has always had.
export function AdvisoryRow({ item, sessionId }: AdvisoryRowProps) {
  const Icon = ADVISORY_ICON[item.severity]
  const className = ADVISORY_CLASS[item.severity]
  const meta = [item.advisor, item.turnsAgo !== undefined ? `T-${item.turnsAgo}` : undefined].filter(Boolean).join(' \u00b7 ')
  // #558 decision 9: a blocker opens by default, live or reopened from history alike -- no
  // live-vs-history branch, same rendering derived purely from the stored `severity` (matches
  // #570 decision 17's own "the same rendering, derived from stored state" precedent). The
  // initializer runs once per mount, whether that mount is a brand-new live item or a reopened
  // history item, so both cases auto-expand identically with no special-casing.
  const [open, setOpen] = React.useState(item.severity === 'blocker')
  const triggerRef = React.useRef<HTMLElement>(null)
  const [polite, announcePolite] = useClearedAnnouncement()

  // #558 decision 9: auto-expansion never steals focus -- a polite live-region announcement
  // only, fired once per mount (never on a later re-render), so a developer reading or typing
  // elsewhere is never interrupted. Fires identically for a live arrival and a history reopen.
  React.useEffect(() => {
    if (item.severity === 'blocker') {
      announcePolite(`Blocker: ${item.text}`)
    }
    // Mount-once: deliberately excludes `announcePolite`/`item` so this never re-fires on a
    // later re-render of the same row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const locations = React.useMemo(() => extractAdvisoryLocations(item.text, item.guidance), [item.text, item.guidance])

  const getCopyText = React.useCallback(() => {
    let text = `${ADVISORY_WORD[item.severity]}: ${item.text}`
    if (locations.length) {
      text += `\n\nLocation${locations.length > 1 ? 's' : ''}:\n${locations.map((location) => location.raw).join('\n')}`
    }
    if (item.guidance) {
      text += `\n\nGuidance:\n${item.guidance}`
    }
    return text
  }, [item.severity, item.text, item.guidance, locations])

  const [asking, setAsking] = React.useState(false)

  async function handleAskAgent() {
    if (asking || !sessionId) return
    setAsking(true)
    let message = `Please address this ${item.severity} from ${item.advisor ?? 'the advisor'}:\n\n"${item.text}"`
    if (item.guidance) {
      message += `\n\nGuidance: ${item.guidance}`
    }
    if (locations.length) {
      message += `\n\nLocation${locations.length > 1 ? 's' : ''}: ${locations.map((location) => location.raw).join(', ')}`
    }
    // Same path a normal user message takes (`window.refract.chat.send`), so Refract's own
    // busy/queue/steer behaviour applies automatically -- it never auto-applies a fix, and
    // there is no override action, since OMP advisors have no gate to override (issue #558).
    const result = await window.refract.chat.send(sessionId, message)
    setAsking(false)
    if (!result.ok) {
      notify(result.error)
      return
    }
    // #558 decision 13: focus returns to the row's own trigger once the send completes -- no
    // unmount occurs here, so a plain ref-based focus suffices.
    triggerRef.current?.focus()
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

  return (
    <div className={cn('border-l-[3px]', open ? ACCENT_CLASS[item.severity] : 'border-transparent')}>
      <CollapsedLine
        ref={triggerRef}
        icon={<Icon className={cn('size-3.5 shrink-0', className)} />}
        label={<span className={className}>{ADVISORY_WORD[item.severity]}</span>}
        summary={item.text}
        summaryClassName={className}
        meta={meta || undefined}
        open={open}
        onOpenChange={setOpen}
      >
        <div className="space-y-2">
          <div className="whitespace-pre-wrap text-sm">{item.text}</div>
          {locations.length > 0 && (
            <div className="space-y-0.5">
              {locations.map((location) => (
                <div key={location.raw} className="select-text font-mono text-xs">
                  {location.raw}
                </div>
              ))}
            </div>
          )}
          {item.guidance && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Guidance</div>
              <div className="whitespace-pre-wrap text-sm">{item.guidance}</div>
            </div>
          )}
          <div className={cn(LABEL_COLUMN_CONTENT_CLASS, 'flex items-center gap-2 pt-1')}>
            <CopyButton getText={getCopyText} label="Copy advisory" announcement="Advisory copied" />
            <Button type="button" variant="outline" size="sm" aria-disabled={asking || !sessionId || undefined} onClick={() => void handleAskAgent()}>
              Ask agent to address this {item.severity}
            </Button>
          </div>
        </div>
      </CollapsedLine>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </span>
    </div>
  )
}

interface AdvisoryRunRowProps {
  group: AdvisoryRun
  sessionId: string | undefined
}

// #558 decision 10: a run of 6+ consecutive concern-severity advisories shows only the newest
// five, in ORIGINAL order, behind a one-way "+ Show N more advisor concerns" reveal (same
// shape as `CappedCodeBlock`'s own "Show all", `ToolCallDialog.tsx`), placed ABOVE the revealed
// rows like `Transcript.tsx`'s own "Load N earlier turns". No re-collapse. A run of five or
// fewer never reaches this component (`groupAdvisoryItems.ts` only wraps above five).
export function AdvisoryRunRow({ group, sessionId }: AdvisoryRunRowProps) {
  const [showAll, setShowAll] = React.useState(false)
  const hiddenCount = group.items.length - 5
  const visible = showAll ? group.items : group.items.slice(-5)
  return (
    <div className="space-y-1">
      {!showAll && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll(true)}>
          + Show {hiddenCount} more advisor concerns
        </Button>
      )}
      {visible.map((runItem) => (
        <AdvisoryRow key={runItem.id} item={runItem} sessionId={sessionId} />
      ))}
    </div>
  )
}
