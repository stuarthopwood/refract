// Pause mode (#477): Pause all / Resume all, in the session list footer between the profile
// button and Settings. Always rendered (disabled when there is nothing to do) so Settings never
// shifts. It reads Resume all only when every live Session that can pause is already paused or
// pausing; otherwise Pause all.
import { PauseIcon, PlayIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { useSessionsStore } from '@/state'
import { setAllPaused } from '@/features/chat/pauseActions'

export function PauseAllButton() {
  const anyPausable = useSessionsStore((s) => s.sessions.some((x) => !x.archivedAt && x.status !== 'stopped' && !x.pause))
  const anyPaused = useSessionsStore((s) => s.sessions.some((x) => !x.archivedAt && !!x.pause))
  const resumeMode = !anyPausable && anyPaused
  const label = resumeMode ? 'Resume all' : 'Pause all'
  return (
    <span className="inline-flex shrink-0">
      <IconButton
        label={label}
        size="icon"
        side="top"
        className="text-muted-foreground hover:text-foreground"
        disabled={!anyPausable && !anyPaused}
        onClick={() => void setAllPaused(!resumeMode)}
      >
        {resumeMode ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
      </IconButton>
    </span>
  )
}
