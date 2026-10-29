// Spec 012 (brand watermark, data-model.md "Renderer-only: the mark itself"): a pure function
// of `watermarkEnabled` -- renders nothing when off. Two variants (research.md decision 9):
// 'live' is the real, responsively-clamped corner mark mounted inside whichever of
// ChatPane.tsx's own eligible render branches is active (research.md decisions 1, 3, 8);
// 'preview' is a small, fixed-size rendering inside the Appearance section
// (AppearanceSection.tsx), sharing the same mask-image/colour/opacity but not the responsive
// clamp or corner anchor, and explicitly ignoring FR-011's full-screen suppression rule since
// it is meant to render inside Settings (research.md decision 9).
//
// Issue #1048 (Holiday touches): in season, with the "Holiday touches" setting not `'off'`,
// this renders the active holiday's own icon (`HOLIDAY_CONTENT`) INSTEAD of the plain Refract
// mark -- same size/anchor/`aria-hidden` contract as the mark itself, just a
// themed `<Icon>` element in place of the `mask-image` `<div>` (simpler than hand-drawing six
// more SVG assets to mask, and every lucide icon is already a flat single-colour glyph). Colour
// comes from `--muted-foreground` (the SAME token the plain mark's own `background-color`
// already uses), never a new hex -- decision 5's "theme tokens only" rule. Opacity comes from
// the per-theme `--holiday-artwork-opacity` (#1233, about 3:1 against the theme background), not
// the plain mark's 0.06 `--watermark-opacity`.
import { cn } from '@/lib/utils'
import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from '@/features/holidays/holidayContent'

interface BrandWatermarkProps {
  /** 'live': the real, responsively-clamped corner mark. 'preview': a small, fixed-size
   *  rendering meant to sit inline inside a bordered preview container in Settings. */
  variant: 'live' | 'preview'
  /** #1256: false where conversation text sits over the corner (a transcript pane), so the plain
   *  low-opacity mark renders instead of the holiday glyph. */
  allowHoliday?: boolean
}

export function BrandWatermark({ variant, allowHoliday = true }: BrandWatermarkProps) {
  const watermarkEnabled = useSettingsStore((s) => s.settings.watermarkEnabled)
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  if (!watermarkEnabled) return null
  const holidayEntry = allowHoliday && holidayTouches !== 'off' && holiday ? HOLIDAY_CONTENT[holiday] : null
  // Quality-gate remediation (code-reviewer/ui-architect, Medium): `-z-10` on the 'live' variant
  // (research.md decision 8 -- previously undone in code) so this absolutely-positioned mark
  // paints BEHIND its normal-flow sibling content (App.tsx's no-pane-open text, this ChatPane's
  // own `!session` Empty state, and the real transcript) instead of over it -- every mount point
  // sets `isolate`, which is what creates its stacking context (`[container-type:size]` applies
  // only style and size containment, not a stacking context), so the mark stays visibly behind
  // its own siblings rather than escaping up into an ancestor stacking context where any
  // background added there later would hide it.
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
