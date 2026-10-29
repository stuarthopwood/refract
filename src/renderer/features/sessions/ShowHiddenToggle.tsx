import { useEffect, useRef } from 'react'
import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { CountBadge } from '@/components/ui/count-badge'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TOOLBAR_BUTTON_CLASS } from '@/components/toolbarButtonClass'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { cn } from '@/lib/utils'
import { useSessionListStore, useSessionsStore } from '@/state'
import { hiddenSummary } from './sessionDisplay'

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
            onPressedChange={(next) => useSessionListStore.getState().setShowHidden(next)}
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
