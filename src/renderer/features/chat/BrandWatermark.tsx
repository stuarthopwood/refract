// Spec 012 (brand watermark, data-model.md "Renderer-only: the mark itself"): a pure function of
// `watermarkEnabled` -- renders nothing when off.
import { cn } from '@/lib/utils'
import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from '@/features/holidays/holidayContent'

interface BrandWatermarkProps {
  variant: 'live' | 'preview'
  // #1256: false where conversation text sits over the corner (a transcript pane), so the plain
  // plain mark (about 1.6:1, #1298) renders instead of the holiday glyph.
  allowHoliday?: boolean
}

export function BrandWatermark({ variant, allowHoliday = true }: BrandWatermarkProps) {
  const watermarkEnabled = useSettingsStore((s) => s.settings.watermarkEnabled)
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  if (!watermarkEnabled) return null
  const holidayEntry = allowHoliday && holidayTouches !== 'off' && holiday ? HOLIDAY_CONTENT[holiday] : null
  if (holidayEntry) {
    const HolidayIcon = holidayEntry.icon
    return (
      <div
        aria-hidden
        className={cn(
          'watermark-mark-holiday pointer-events-none flex items-center justify-center',
          variant === 'live' ? 'watermark-mark--live -z-10' : 'size-24'
        )}
      >
        <HolidayIcon
          aria-hidden
          focusable={false}
          className="size-full"
          style={{ color: 'var(--muted-foreground)', opacity: 'var(--holiday-artwork-opacity)' }}
          strokeWidth={1.5}
        />
      </div>
    )
  }
  return (
    <div
      aria-hidden
      className={cn('watermark-mark pointer-events-none', variant === 'live' ? 'watermark-mark--live -z-10' : 'size-24')}
    />
  )
}
