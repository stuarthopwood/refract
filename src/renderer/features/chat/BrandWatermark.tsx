// Spec 012 (brand watermark, data-model.md "Renderer-only: the mark itself"): a pure function of
// `watermarkEnabled` -- renders nothing when off.
import { BrandMark } from '@/components/brand/BrandMark'
import { cn } from '@/lib/utils'
import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from '@/features/holidays/holidayContent'

interface BrandWatermarkProps {
  variant: 'live' | 'preview'
}

// #1647 (reverses #1256's `allowHoliday={false}`): in season, every caller shows the holiday glyph;
// both marks are faint enough (about 1.3:1) not to compete with transcript text.
export function BrandWatermark({ variant }: BrandWatermarkProps) {
  const watermarkEnabled = useSettingsStore((s) => s.settings.watermarkEnabled)
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  if (!watermarkEnabled) return null
  const holidayEntry = holidayTouches !== 'off' && holiday ? HOLIDAY_CONTENT[holiday] : null
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
    >
      <BrandMark className="size-full" />
    </div>
  )
}
