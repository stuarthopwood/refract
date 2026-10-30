import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from './holidayContent'

/** Decorative holiday icon for the profile row (#1048, #1385); renders nothing when touches are off or no holiday is active. */
export function HolidayAccessory() {
  const holidayTouches = useSettingsStore((state) => state.settings.holidayTouches)
  const activeHolidayId = useHolidayStore((state) => state.activeHoliday)
  const entry = holidayTouches !== 'off' && activeHolidayId ? HOLIDAY_CONTENT[activeHolidayId] : null
  if (!entry) return null
  return <entry.icon aria-hidden focusable={false} className="ml-1 size-4 shrink-0 text-muted-foreground" />
}
