import { CircleAlertIcon, CircleArrowRightIcon, CircleDotIcon, CircleIcon, type LucideIcon } from 'lucide-react'
import type { ItemStatus } from '../../../../shared/checklist'
import { STATUS_GLYPH } from '../../chat/statusGlyph'

/** What a Checklist item status looks like: an icon, a colour class and a word; `showWord` says whether the word is visible or screen-reader-only. */
export interface ChecklistStatusGlyph {
  Icon: LucideIcon
  className: string
  word: string
  showWord: boolean
}

// Feature-local on purpose: a Checklist item is not a Todo task, so `TodoTree`'s map is not shared.
// `complete` and `in_progress` share a colour in dark presets, so their icon shape and word must differ.
export const CHECKLIST_STATUS_GLYPH: Record<ItemStatus, ChecklistStatusGlyph> = {
  upcoming: { Icon: CircleIcon, className: 'text-muted-foreground', word: 'Upcoming', showWord: false },
  next: { Icon: CircleArrowRightIcon, className: 'text-foreground', word: 'Next', showWord: true },
  in_progress: { Icon: CircleDotIcon, className: 'text-state-working', word: 'In progress', showWord: true },
  blocked: { Icon: CircleAlertIcon, className: 'text-severity-warning', word: 'Blocked', showWord: true },
  complete: { ...STATUS_GLYPH['success-done'], word: 'Complete', showWord: false }
}
