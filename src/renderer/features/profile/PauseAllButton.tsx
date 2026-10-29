// Pause mode (#477): Pause all / Resume all, in the session list footer between the profile
// button and Settings. One toggle: it reads Resume all while any Session is paused, and is hidden
// when nothing can be paused or resumed.
import { PauseIcon, PlayIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/state'
import { setAllPaused } from '@/features/chat/pauseActions'

export function PauseAllButton() {
  const anyPaused = useSessionsStore((s) => s.sessions.some((x) => !!x.pause))
  const anyPausable = useSessionsStore((s) => s.sessions.some((x) => x.status !== 'stopped' && !x.archivedAt))
  if (!anyPaused && !anyPausable) return null
  const label = anyPaused ? 'Resume all' : 'Pause all'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={() => void setAllPaused(!anyPaused)}
        >
          {anyPaused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
