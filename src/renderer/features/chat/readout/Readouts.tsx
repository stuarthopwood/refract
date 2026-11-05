import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'
import { EyeIcon, Loader2Icon, PinIcon } from 'lucide-react'
import { READOUT_KIND_ICONS } from '@/components/icons/readout-icons'
import { EMPTY_QUEUE, EMPTY_READOUT_ENTRY, notify, useAdvisorStore, useDraftStore, useQueueStore, useReadoutStore, useSessionsStore, useTodoPinStore } from '@/state'
import { openHostedPanel } from '@/features/right-pane/hosted-panel-actions'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { DiffStatLine, formatDiffStatAccessible } from '@/features/sessions/sessionDisplay'
import { formatElapsed } from '../formatElapsed'
import { COMPOSER_DISABLED_HOVER_RESET_CLASS, COMPOSER_DISABLED_OPACITY_CLASS } from '../pickerShared'
import { AgentsCard } from './AgentsCard'
import { AlarmClock } from './AlarmClock'
import { READOUT_ITEM_BASE_CLASS, READOUT_ITEM_INTERACTIVE_ADDITIONS, ReadoutItem } from './ReadoutItem'
import { TodoCard } from './TodoCard'
import { deriveSubagentPhrase } from './subagentDerive'
import { deriveTodoTotals, hasTodoPlan } from './todoDerive'
import { useReadoutCard } from './useReadoutCard'

export function ChangesReadout({ sessionId }: { sessionId: string }) {
  const changes = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.changes)
  const onActivate = (event: MouseEvent<HTMLButtonElement>) =>
    openHostedPanel('git-changes', sessionId, { opener: event.currentTarget })
  if (changes === null) return null
  if (changes === 'not-available') {
    return (
      <ReadoutItem icon={READOUT_KIND_ICONS.changes} onActivate={onActivate} accessibleName="Open Git changes panel (Not available)">
        <span>Not available</span>
      </ReadoutItem>
    )
  }
  return (
    <ReadoutItem
      icon={READOUT_KIND_ICONS.changes}
      onActivate={onActivate}
      accessibleName={`Open Git changes panel (${formatDiffStatAccessible(changes)})`}
    >
      <DiffStatLine stat={changes} />
    </ReadoutItem>
  )
}

/** Ticks the elapsed time once a second from `startedAt`; hidden when no turn runs. */
export function TurnTimeReadout({ sessionId }: { sessionId: string }) {
  const startedAt = useReadoutStore(
    (s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.turnTime?.startedAt ?? null
  )
  const [now, setNow] = useState(() => Date.now())
  useLayoutEffect(() => {
    if (startedAt === null) return
    // Layout effect (not a passive one): a stale `now` from the previous turn (or the mount) must
    // never paint, so a resumed turn does not flash an elapsed time that is not its own.
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  if (startedAt === null) return null
  return (
    <ReadoutItem icon={READOUT_KIND_ICONS['turn-time']}>
      <span>{formatElapsed(Math.max(0, now - startedAt))}</span>
    </ReadoutItem>
  )
}

/** Pure client clock updating each minute; no `aria-live` (the tick is never announced), name read on focus. */
export function CurrentTimeReadout({ className }: { className?: string } = {}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined
    const msToNextMinute = 60_000 - (Date.now() % 60_000)
    const timeout = setTimeout(() => {
      setNow(new Date())
      interval = setInterval(() => setNow(new Date()), 60_000)
    }, msToNextMinute)
    return () => {
      clearTimeout(timeout)
      if (interval) clearInterval(interval)
    }
  }, [])
  const formatted = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(now)
  return <AlarmClock formatted={formatted} now={now} className={className} />
}

export function SubagentsReadout({ sessionId }: { sessionId: string }) {
  const subagentCount = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.subagentCount)
  const subagents = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents)
  // Same `useReadoutCard` controller as the Todo pill; never a Radix `Tooltip`/`HoverCard`.
  const card = useReadoutCard({ disabled: (subagentCount?.running ?? 0) === 0 })
  const onActivate = (event: MouseEvent<HTMLButtonElement>) => {
    card.close()
    openHostedPanel('subagents', sessionId, { opener: event.currentTarget })
  }
  const onOpenPanelFromCard = () => {
    card.close()
    card.anchorRef.current?.focus({ preventScroll: true })
    openHostedPanel('subagents', sessionId, { opener: card.anchorRef.current })
  }
  if (subagentCount === null) return null
  const phrase = deriveSubagentPhrase(subagentCount)
  return (
    <Popover
      open={card.open}
      onOpenChange={(next) => {
        if (!next) card.close()
      }}
    >
      <PopoverAnchor asChild>
        <ReadoutItem
          ref={card.anchorRef}
          icon={READOUT_KIND_ICONS.subagents}
          onActivate={onActivate}
          accessibleName={`Open subagents panel (${phrase})`}
          // Flipped so the running state stands out.
          className={subagentCount.running > 0 ? 'text-foreground' : undefined}
          onPointerEnter={card.anchorHandlers.onPointerEnter}
          onPointerMove={card.anchorHandlers.onPointerMove}
          onPointerLeave={card.anchorHandlers.onPointerLeave}
          onFocus={card.anchorHandlers.onFocus}
          onBlur={card.anchorHandlers.onBlur}
        >
          <span aria-hidden>{phrase}</span>
        </ReadoutItem>
      </PopoverAnchor>
      <PopoverContent
        data-slot="agents-card"
        side="top"
        align="start"
        collisionPadding={8}
        className="w-auto p-4"
        onPointerEnter={card.contentHandlers.onPointerEnter}
        onPointerLeave={card.contentHandlers.onPointerLeave}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <AgentsCard subagents={subagents} counts={subagentCount} onOpenPanel={onOpenPanelFromCard} />
      </PopoverContent>
    </Popover>
  )
}

export function TodoProgressReadout({ sessionId }: { sessionId: string }) {
  const todoTree = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.todoTree)
  const pinned = useTodoPinStore((s) => s.pinnedBySession[sessionId] ?? false)
  const togglePinned = useTodoPinStore((s) => s.togglePinned)
  // `disabled` forces `card.open` false and ignores hover/focus: while pinned, and while there is no plan,
  // so a conversation reset cannot leave the card to reopen itself when the plan returns.
  const card = useReadoutCard({ disabled: pinned || !hasTodoPlan(todoTree) })
  const onActivate = () => {
    card.close()
    togglePinned(sessionId)
  }
  if (!hasTodoPlan(todoTree)) return null
  const totals = deriveTodoTotals(todoTree)
  if (!totals) return null // unreachable given hasTodoPlan above; keeps TS narrowed without a cast
  return (
    <Popover
      open={card.open}
      onOpenChange={(next) => {
        if (!next) card.close()
      }}
    >
      <PopoverAnchor asChild>
        <ReadoutItem
          ref={card.anchorRef}
          icon={pinned ? PinIcon : READOUT_KIND_ICONS['todo-progress']}
          onActivate={onActivate}
          accessibleName={`Pin todo list (Todo ${totals.done}/${totals.total})`}
          pressed={pinned}
          controls={`todo-panel-${sessionId}`}
          pinHookId={sessionId}
          className={pinned ? 'aria-pressed:border aria-pressed:border-ring' : undefined}
          onPointerEnter={card.anchorHandlers.onPointerEnter}
          onPointerMove={card.anchorHandlers.onPointerMove}
          onPointerLeave={card.anchorHandlers.onPointerLeave}
          onFocus={card.anchorHandlers.onFocus}
          onBlur={card.anchorHandlers.onBlur}
        >
          {/* sr-only text carries the count for screen readers, as in CurrentTimeReadout. */}
          <span className="sr-only">{`Todo: ${totals.done} of ${totals.total} tasks done`}</span>
          <span aria-hidden>
            Todo {totals.done}/{totals.total}
          </span>
        </ReadoutItem>
      </PopoverAnchor>
      <PopoverContent
        data-slot="todo-card"
        side="top"
        align="start"
        collisionPadding={8}
        className="w-auto p-4"
        onPointerEnter={card.contentHandlers.onPointerEnter}
        onPointerLeave={card.contentHandlers.onPointerLeave}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <TodoCard todoTree={todoTree} />
      </PopoverContent>
    </Popover>
  )
}

const ADVISOR_TURN_OFF_TIMEOUT_MS = 10_000
const ADVISOR_QUEUED_TIMEOUT_MS = 60_000

export function AdvisorReadout({ sessionId, textareaRef }: { sessionId: string; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const advisorOn = useAdvisorStore((s) => s.bySession[sessionId] ?? false)
  if (!advisorOn) return null
  return <AdvisorReadoutButton key={sessionId} sessionId={sessionId} textareaRef={textareaRef} />
}

function AdvisorReadoutButton({ sessionId, textareaRef }: { sessionId: string; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const [turningOff, setTurningOff] = useState(false)
  const [queuedOff, setQueuedOff] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const timeoutRef = useRef<number | undefined>(undefined)
  const turningOffRef = useRef(false)
  turningOffRef.current = turningOff

  function resetBusy() {
    setTurningOff(false)
    setQueuedOff(false)
  }

  useLayoutEffect(() => {
    return () => {
      window.clearTimeout(timeoutRef.current)
      // Read directly from the store (not a hook) -- a cleanup closure cannot call hooks.
      const stillOn = useAdvisorStore.getState().bySession[sessionId] ?? false
      if (turningOffRef.current && !stillOn) {
        useDraftStore.getState().announceAttachment(sessionId, 'Advisor off')
      }
      if (buttonRef.current?.contains(document.activeElement)) {
        textareaRef.current?.focus()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const queue = useQueueStore((s) => s.bySession[sessionId] ?? EMPTY_QUEUE)
  const wasQueuedRef = useRef(false)
  useEffect(() => {
    const stillQueued = queue.followUp.includes('/advisor off') || queue.steering.includes('/advisor off')
    if (stillQueued) {
      wasQueuedRef.current = true
      return
    }
    if (!wasQueuedRef.current) return
    wasQueuedRef.current = false
    if (turningOffRef.current) {
      setQueuedOff(false)
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = window.setTimeout(resetBusy, ADVISOR_TURN_OFF_TIMEOUT_MS)
    }
  }, [queue])

  const sessionStatus = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const wasWorkingRef = useRef(false)
  useEffect(() => {
    const wasWorking = wasWorkingRef.current
    wasWorkingRef.current = sessionStatus === 'working'
    if (wasWorking && sessionStatus !== 'working' && turningOffRef.current) {
      setQueuedOff(false)
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = window.setTimeout(resetBusy, ADVISOR_TURN_OFF_TIMEOUT_MS)
    }
  }, [sessionStatus])

  function handleActivate() {
    if (turningOff) return
    setTurningOff(true)
    timeoutRef.current = window.setTimeout(resetBusy, ADVISOR_TURN_OFF_TIMEOUT_MS)
    window.refract.chat
      .send(sessionId, '/advisor off')
      .then((result) => {
        if (!result.ok) {
          window.clearTimeout(timeoutRef.current)
          resetBusy()
          notify(result.error)
          return
        }
        // Only acts if the item is STILL actually in the queue right now (a direct store read, not
        // the possibly-stale `queue` closed over above).
        if (result.value.queued) {
          const live = useQueueStore.getState().bySession[sessionId] ?? EMPTY_QUEUE
          if (live.followUp.includes('/advisor off') || live.steering.includes('/advisor off')) {
            setQueuedOff(true)
            window.clearTimeout(timeoutRef.current)
            timeoutRef.current = window.setTimeout(resetBusy, ADVISOR_QUEUED_TIMEOUT_MS)
          }
        }
      })
      .catch((err: unknown) => {
        window.clearTimeout(timeoutRef.current)
        resetBusy()
        notify({ code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) })
      })
  }

  const label = queuedOff
    ? 'Advisor on. Turning off after the current turn…'
    : turningOff
      ? 'Advisor on. Turning off…'
      : 'Advisor on. Turn off'
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <button
          ref={buttonRef}
          data-slot="readout-chip"
          type="button"
          onClick={handleActivate}
          aria-label={label}
          aria-disabled={turningOff}
          className={cn(
            READOUT_ITEM_BASE_CLASS,
            READOUT_ITEM_INTERACTIVE_ADDITIONS,
            turningOff && COMPOSER_DISABLED_OPACITY_CLASS,
            turningOff && COMPOSER_DISABLED_HOVER_RESET_CLASS,
            turningOff && 'aria-disabled:hover:text-muted-foreground'
          )}
        >
          {turningOff ? (
            <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <EyeIcon aria-hidden className="size-4" />
          )}
          <span aria-hidden>Advisor</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
