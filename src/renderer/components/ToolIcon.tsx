import { cn } from '@/lib/utils'
import { resolveToolDisplay } from '@/features/chat/toolDisplay'

export interface ToolIconProps {
  tool: string
  target?: string
  tone?: 'muted' | 'error'
  className?: string
}

// Spec 023 FR-001, FR-015, FR-021 (research Decision 7): the one shared tool glyph, resolved from
// the verb map through `resolveToolDisplay`. Decorative only: the label and the tooltip carry the
// tool's meaning, so the glyph is hidden from assistive technology.
export function ToolIcon({ tool, target, tone = 'muted', className }: ToolIconProps) {
  const Icon = resolveToolDisplay(tool, target).icon
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-4 shrink-0', tone === 'error' ? 'text-severity-error' : 'text-muted-foreground', className)}
    />
  )
}
