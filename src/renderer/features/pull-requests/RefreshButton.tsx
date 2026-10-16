// Shared ghost icon-only refresh button for the pull request list and detail views (research.md
// decision 8: both call sites settle on the detail view's existing `size-4` icon, not the list's
// old smaller icon).
import { RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface RefreshButtonProps {
  loading: boolean
  onClick: () => void
  label: string
  className?: string
}

export function RefreshButton({ loading, onClick, label, className }: RefreshButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={loading}
          onClick={onClick}
          className={className}
        >
          <RefreshCwIcon aria-hidden className={cn('size-4', loading && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
