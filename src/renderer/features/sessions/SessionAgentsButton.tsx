// #507 (spec 047): the Session row's agents button -- the running subagent count as real text
// beside an icon, opening the Subagents panel on that Session. Renders nothing at zero so a quiet
// row stays quiet and reserves no space. Kept beside its only consumer until a second caller
// appears (ui-architect-v3 ruling); built from the shared `Button` and `Tooltip`.
import { UsersIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { openHostedPanel } from '@/features/right-pane/hosted-panel-actions'
import { cn } from '@/lib/utils'

export function agentsButtonLabel(running: number, sessionName: string): string {
  return `${running} ${running === 1 ? 'agent' : 'agents'} running in ${sessionName}. Open Agents panel.`
}

interface SessionAgentsButtonProps {
  sessionId: string
  sessionName: string
  running: number
  /** Selects the Session the way a row click does, before the panel opens on it. */
  onSelect: () => void
  className?: string
}

export function SessionAgentsButton({ sessionId, sessionName, running, onSelect, className }: SessionAgentsButtonProps) {
  if (running <= 0) return null
  const label = agentsButtonLabel(running, sessionName)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={label}
          data-session-agents={sessionId}
          className={cn('h-6 w-9 gap-1 px-0 tabular-nums', className, COMPOSER_BUTTON_FOCUS_CLASS)}
          onClick={(event) => {
            onSelect()
            openHostedPanel('subagents', sessionId, { opener: event.currentTarget })
          }}
        >
          <UsersIcon aria-hidden className="size-3.5" />
          <span aria-hidden>{running > 9 ? '9+' : running}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
