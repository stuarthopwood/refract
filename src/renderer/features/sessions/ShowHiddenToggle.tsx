import { useEffect, useRef } from 'react'
import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { CountBadge } from '@/components/ui/count-badge'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TOOLBAR_BUTTON_CLASS } from '@/components/toolbarButtonClass'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { cn } from '@/lib/utils'
import { useSessionListStore, useSessionsStore } from '@/state'
import { hiddenSummary } from './sessionDisplay'

// Long enough to land after the "Unhid" announcement that precedes it.
const UNHID_ANNOUNCE_DELAY_MS = 600

function focusCollapseAll(): void {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-collapse-all-groups], button[aria-label="Collapse all groups"]')?.focus()
  )
}

// Issue #748: the Show hidden toggle in the session list's toolbar row. Rendered only while a
// Session is hidden or the toggle is on (so it never offers a control with nothing behind it,
// and never vanishes from under a user who just turned it on). A hidden Session never
// resurfaces by itself, so this toggle's name and badge are the only place the list reports
// that a hidden Session needs attention; the same `groupWaitingState` rule the row icons use
// feeds the count, so the two always agree.
export function ShowHiddenToggle() {
  const sessions = useSessionsStore((state) => state.sessions)
  const showHidden = useSessionListStore((state) => state.showHidden)
  const { hidden, attention, needsYou } = hiddenSummary(sessions)
  const [announcement, announce] = useClearedAnnouncement()
  const previousAttentionRef = useRef(attention)
  useEffect(() => {
    if (attention === previousAttentionRef.current) return
    const previous = previousAttentionRef.current
    previousAttentionRef.current = attention
    if (attention <= previous) return
    // Debounced so a burst of status changes reads once.
    const timer = setTimeout(() => announce(`${attention} hidden ${attention === 1 ? 'Session needs' : 'Sessions need'} attention`), 1000)
    return () => clearTimeout(timer)
  }, [attention, announce])
  const previousHiddenRef = useRef(hidden)
  useEffect(() => {
    const previous = previousHiddenRef.current
    previousHiddenRef.current = hidden
    if (hidden > 0 || previous === 0 || !showHidden) return
    // The toggle unmounts as soon as this runs, so capture whether it held focus first.
    const hadFocus = document.activeElement?.hasAttribute('data-show-hidden-toggle') ?? false
    useSessionListStore.getState().setShowHidden(false)
    // This component unmounts now, so its own live region cannot speak; use the app-level announcer.
    // Deferred, and deliberately not cleared on unmount (this component unmounts right now), so it follows an "Unhid" announcement instead of replacing it.
    setTimeout(() => {
      if (hiddenSummary(useSessionsStore.getState().sessions).hidden === 0 && !useSessionListStore.getState().showHidden) {
        useChatAreaAnnouncer.getState().announce('Show hidden turned off, no hidden sessions')
      }
    }, UNHID_ANNOUNCE_DELAY_MS)
    if (hadFocus) focusCollapseAll()
  }, [hidden, showHidden])
  if (hidden === 0 && !showHidden) return null
  const detail = needsYou > 0 ? `, ${needsYou} needs you` : attention > 0 ? `, ${attention} need attention` : ''
  const name = `Show hidden Sessions, ${hidden}${detail}`
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            variant="subtle"
            size="icon-xs"
            pressed={showHidden}
            onPressedChange={(next) => {
              useSessionListStore.getState().setShowHidden(next)
              // Turning it off with nothing hidden removes this control; keep focus in the toolbar.
              if (!next && hidden === 0) focusCollapseAll()
            }}
            aria-label={name}
            data-show-hidden-toggle=""
            className={cn('relative', TOOLBAR_BUTTON_CLASS)}
          >
            {showHidden ? <EyeIcon aria-hidden /> : <EyeOffIcon aria-hidden />}
            {attention > 0 && <CountBadge value={attention} />}
          </Toggle>
        </TooltipTrigger>
        <TooltipContent side="right">Show hidden Sessions</TooltipContent>
      </Tooltip>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </>
  )
}
