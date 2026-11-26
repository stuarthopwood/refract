// The Subagents card's Goal strip (FR-146 b): the view-model's `overallGoal` under the header, or nothing.
// It never derives a fallback; the view-model owns that (FR-145), so an absent goal leaves no gap.
import { TargetIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ICON_SLOT_CLASS } from '../../chat/CollapsedLine'

export function GoalStrip({ goal, className }: { goal: string | undefined; className?: string }) {
  if (!goal) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <div data-slot="goal-strip" className={cn('flex items-start gap-2 border-t border-divider bg-surface-1 px-2 py-2 text-xs', className)}>
          <span aria-hidden="true" className={cn(ICON_SLOT_CLASS, 'text-muted-foreground')}>
            <TargetIcon className="size-3.5" />
          </span>
          <span className="shrink-0 font-medium text-muted-foreground">Goal:</span>
          {/* The clamp only hides overflow visually; the whole text stays in the DOM for a screen reader. */}
          <span className="line-clamp-2 min-w-0 break-words text-foreground">{goal}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <span className="break-words">{goal}</span>
      </TooltipContent>
    </Tooltip>
  )
}
