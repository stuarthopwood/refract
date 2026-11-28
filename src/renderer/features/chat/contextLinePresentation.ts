import { BellOffIcon, InfoIcon, ListChecksIcon, type LucideIcon } from 'lucide-react'
import type { ContextLineKind } from '../../../shared/contextLines'

// The Away icon is the one the Away mode menu item shows (WorkingModeMenu.tsx).
export const CONTEXT_PRESENTATION = {
  away: { icon: BellOffIcon, label: 'Away Mode:' },
  checklist: { icon: ListChecksIcon, label: 'Refract:' },
  refract: { icon: InfoIcon, label: 'Refract:' }
} as const satisfies Record<ContextLineKind, { icon: LucideIcon; label: string }>
