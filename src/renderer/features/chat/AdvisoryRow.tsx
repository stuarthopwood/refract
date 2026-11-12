import * as React from 'react'
import { EyeIcon, InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { InlineCode } from '@/components/ui/inline-code'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { SourceTag } from '@/components/SourceTag'
import { CopyButton } from '@/components/ui/copy-button'
import { extractAdvisoryLocations, type AdvisoryLocation } from '@/lib/advisory-locations'
import { notify, useSessionsStore } from '@/state'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/components/ui/composerFocus'
import { COMPOSER_DISABLED_OPACITY_CLASS } from './pickerShared'
import { CONCERN_RUN_THRESHOLD, type AdvisoryRun } from './groupAdvisoryItems'

type AdvisoryItem = Extract<TranscriptItem, { kind: 'advisory' }>

const ADVISORY_ICON = {
  blocker: OctagonAlertIcon,
  concern: TriangleAlertIcon,
  nit: InfoIcon
} as const satisfies Record<AdvisoryItem['severity'], unknown>

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

// The stripe is the expanded body's `::before`, not the card's, so it never crosses the header line;
// `left-2` matches the card's left edge (the collapsible root is `-mx-2`).
const STRIPE_CLASS = {
  blocker:
    "relative before:absolute before:inset-y-0 before:left-2 before:w-[3px] before:bg-severity-error before:pointer-events-none before:forced-color-adjust-none before:content-[''] forced-colors:before:bg-[CanvasText]",
  concern:
    "relative before:absolute before:inset-y-0 before:left-2 before:w-[3px] before:bg-severity-warning before:pointer-events-none before:forced-color-adjust-none before:content-[''] forced-colors:before:bg-[CanvasText]"
} as const

interface AdvisoryRowProps {
  item: AdvisoryItem
  sessionId: string | undefined
  onQueuedAnnounce: (text: string) => void
}

function turnsAgoPhrase(turnsAgo: number): string {
  return turnsAgo === 0 ? 'this turn' : `${turnsAgo} ${turnsAgo === 1 ? 'turn' : 'turns'} ago`
}

// The advisor name lives in the SourceTag tooltip (hover only), so the trigger's accessible name
// carries it for assistive technology; the name is omitted when unset.
function buildTriggerLabel(item: AdvisoryItem): string {
  const preview = item.text.replace(/\s+/g, ' ').trim().slice(0, 120)
  const parts = [item.advisor ? `Advisor (${item.advisor})` : 'Advisor', item.severity, preview]
  if (item.turnsAgo !== undefined) parts.push(`T-${item.turnsAgo}`, turnsAgoPhrase(item.turnsAgo))
  return parts.join(', ')
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

const MAX_ASK_AGENT_PAYLOAD_LENGTH = 8_000

function buildAskAgentMessage(item: AdvisoryItem, locations: AdvisoryLocation[]): string {
  let payload = item.advisor ? `Advisor: ${item.advisor}\n\n${item.text}` : item.text
  if (item.guidance) {
    payload += `\n\nGuidance: ${item.guidance}`
  }
  if (locations.length) {
    payload += `\n\nLocation${locations.length > 1 ? 's' : ''}: ${locations.map((location) => location.raw).join(', ')}`
  }
  if (payload.length > MAX_ASK_AGENT_PAYLOAD_LENGTH) {
    const cutIndex =
      payload.charCodeAt(MAX_ASK_AGENT_PAYLOAD_LENGTH - 1) >= 0xd800 && payload.charCodeAt(MAX_ASK_AGENT_PAYLOAD_LENGTH - 1) <= 0xdbff
        ? MAX_ASK_AGENT_PAYLOAD_LENGTH - 1
        : MAX_ASK_AGENT_PAYLOAD_LENGTH
    payload = `${payload.slice(0, cutIndex)}\u2026 [truncated]`
  }
  const longestBacktickRun = (payload.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  return `Please address this ${item.severity} from ${item.advisor ?? 'the advisor'}:\n\n${fence}advisor-note\n${payload}\n${fence}`
}

export const AdvisoryRow = React.forwardRef<HTMLElement, AdvisoryRowProps>(function AdvisoryRow({ item, sessionId, onQueuedAnnounce }, forwardedRef) {
  const Icon = ADVISORY_ICON[item.severity]
  const className = ADVISORY_CLASS[item.severity]
  const meta = item.turnsAgo !== undefined ? `T-${item.turnsAgo}` : undefined
  const leading = <SourceTag icon={EyeIcon} label="Advisor" tooltip={item.advisor} className="text-sm" />
  const triggerAriaLabel = buildTriggerLabel(item)
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
          notify({ code: 'prompt-failed', message: 'Could not start the agent for this Session.' })
          return
        }
      }
      const message = buildAskAgentMessage(item, locations)
      const result = await window.refract.chat.send(sessionId, message)
      if (!result.ok) {
        notify(
          result.error.code === 'agent-not-running'
            ? { code: result.error.code, message: 'The agent is not running for this Session.' }
            : result.error
        )
        return
      }
      if (result.value.queued) onQueuedAnnounce('Queued for agent')
      if (document.activeElement === askButtonRef.current || document.activeElement === document.body) {
        innerRef.current?.focus({ preventScroll: true })
      }
    } catch {
      notify({ code: 'prompt-failed', message: 'Could not send this to the agent.' })
    } finally {
      setAsking(false)
    }
  }

  if (item.severity === 'nit') {
    return (
      <CollapsedLine
        leading={leading}
        triggerAriaLabel={triggerAriaLabel}
        icon={<Icon className={cn('size-4 shrink-0', className)} />}
        label={<span className={className}>{ADVISORY_WORD[item.severity]}</span>}
        summary={item.text}
        meta={meta}
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
  const askReason = !sessionId ? 'No Session to send this to.' : sessionUnavailable ? 'Start the agent to send this.' : undefined

  return (
    <div data-advisory-severity={item.severity}>
      <CollapsedLine
        ref={innerRef}
        leading={leading}
        triggerAriaLabel={triggerAriaLabel}
        icon={<Icon className={cn('size-4 shrink-0', className)} />}
        label={<span className={className}>{ADVISORY_WORD[item.severity]}</span>}
        summary={item.text}
        meta={meta}
        open={open}
        onOpenChange={setOpen}
        contentClassName={cn(LABEL_COLUMN_CONTENT_CLASS, STRIPE_CLASS[item.severity])}
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
              <div key={location.raw} className="select-text [overflow-wrap:anywhere]">
                <InlineCode>{location.raw}</InlineCode>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <CopyButton getText={getCopyText} label="Copy advisory" announcement="Advisory copied" />
          <Button
            ref={askButtonRef}
            type="button"
            variant="ghost"
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
  onReveal?: () => void
  onQueuedAnnounce: (text: string) => void
}

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
          className={cn('px-2 focus-visible:ring-0', INSET_FOCUS_OUTLINE_CLASS)}
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
