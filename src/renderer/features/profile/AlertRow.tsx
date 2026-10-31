import type { RefObject } from 'react'
import { AlertTriangleIcon, XIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { Button } from '@/components/ui/button'
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
  onDismiss
}: AlertRowProps) {
  return (
    <div ref={containerRef} className={cn('flex items-center gap-2 py-1 pl-2 text-xs', wrapLabel && 'items-start')}>
      <AlertTriangleIcon aria-hidden className="size-4 shrink-0 text-state-needs-you" />
      <span className={cn('min-w-0 flex-1 text-muted-foreground', wrapLabel ? 'whitespace-normal' : 'truncate')}>{label}</span>
      <Button
        ref={actionRef}
        type="button"
        variant="text"
        size="xs"
        aria-label={actionAriaLabel}
        className="-mx-1 h-auto px-1 py-1"
        onClick={onAction}
      >
        {actionLabel}
      </Button>
      <IconButton label={dismissAriaLabel} className={cn('text-muted-foreground', wrapLabel && '-my-1')} onClick={onDismiss}>
        <XIcon aria-hidden />
      </IconButton>
    </div>
  )
}
