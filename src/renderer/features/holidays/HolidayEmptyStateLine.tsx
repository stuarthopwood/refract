// Issue #1048 (Holiday touches): the one decorative empty-state line component, shared by
// `App.tsx`'s own real no-pane-open empty state, `ChatPane.tsx`'s rare `!session` branch, and
// `ManageSessionsScreen.tsx`'s "No sessions yet" -- one place computing `holidayEntry` for this
// placement, never three separate hand-copied hook reads (and #806's own file-size cap leaves
// none of those three files room for a second copy of this logic inline).
import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from './holidayContent'

interface HolidayEmptyStateLineProps {
  /** Layout/typography utilities only -- this component owns `aria-hidden`, never its caller. */
  className?: string
}

export function HolidayEmptyStateLine({ className }: HolidayEmptyStateLineProps) {
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  const entry = holidayTouches !== 'off' && holiday ? HOLIDAY_CONTENT[holiday] : null
  if (!entry) return null
  return (
    <span aria-hidden className={className}>
      {entry.emptyStateLine}
    </span>
  )
}
