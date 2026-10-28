import type { RefObject } from 'react'
import { AlertTriangleIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { cn } from '@/lib/utils'

/** One quiet alert row: an icon, a quieter label, one amber text action, and a dismiss button.
 *  Extracted (quality-gate remediation, round 2) since the memory and omp-version rows were
 *  otherwise near-identical. */
interface AlertRowProps {
  containerRef: RefObject<HTMLDivElement | null>
  label: string
  /** The low-memory row's own text stays bounded and keeps truncating; the omp-version row's
   *  embeds an arbitrary version string and needs to wrap instead (item 11). */
  wrapLabel?: boolean
  actionRef: RefObject<HTMLButtonElement | null>
  actionLabel: string
  actionAriaLabel: string
  onAction(): void
  dismissAriaLabel: string
  dismissTooltip: string
  onDismiss(): void
}

export function AlertRow({
  containerRef,
  label,
  wrapLabel,
  actionRef,
  actionLabel,
  actionAriaLabel,
  onAction,
  dismissAriaLabel,
  dismissTooltip,
  onDismiss
}: AlertRowProps) {
  return (
    <div ref={containerRef} className="flex h-6 items-center gap-2 pl-2 text-xs">
      <AlertTriangleIcon aria-hidden className="size-4 shrink-0 text-state-needs-you" />
      <span className={cn('min-w-0 flex-1 text-muted-foreground', wrapLabel ? 'whitespace-normal' : 'truncate')}>{label}</span>
      <Button
        ref={actionRef}
        type="button"
        variant="link"
        size="xs"
        aria-label={actionAriaLabel}
        className={cn(COMPOSER_BUTTON_FOCUS_CLASS, '-mx-1 h-auto px-1 py-1 text-state-needs-you underline')}
        onClick={onAction}
      >
        {actionLabel}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={dismissAriaLabel}
            className={cn(COMPOSER_BUTTON_FOCUS_CLASS, 'text-state-needs-you hover:text-state-needs-you')}
            onClick={onDismiss}
          >
            <XIcon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{dismissTooltip}</TooltipContent>
      </Tooltip>
    </div>
  )
}
