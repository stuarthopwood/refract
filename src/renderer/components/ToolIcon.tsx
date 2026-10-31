import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ToolIconProps {
  /** The resolved glyph; feature code picks it (for a tool row, `resolveToolDisplay(tool, target).icon`). */
  icon: LucideIcon
  tone?: 'muted' | 'error'
  className?: string
}

// Spec 023 FR-001, FR-015, FR-021 (research Decision 7): the one shared tool glyph. The caller
// resolves the icon from the verb map, so this component never imports feature code. Decorative
// only: the label and the tooltip carry the tool's meaning, so the glyph is hidden from
// assistive technology.
export function ToolIcon({ icon: Icon, tone = 'muted', className }: ToolIconProps) {
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-4 shrink-0', tone === 'error' ? 'text-tool-row-error-fg' : 'text-tool-row-fg', className)}
    />
  )
}
