// Spec 012 (brand watermark, data-model.md "Renderer-only: the mark itself"): a pure function
// of `watermarkEnabled` -- renders nothing when off. Two variants (research.md decision 9):
// 'live' is the real, responsively-clamped corner mark mounted inside whichever of
// ChatPane.tsx's own eligible render branches is active (research.md decisions 1, 3, 8);
// 'preview' is a small, fixed-size rendering inside the Appearance section
// (AppearanceSection.tsx), sharing the same mask-image/colour/opacity but not the responsive
// clamp or corner anchor, and explicitly ignoring FR-011's full-screen suppression rule since
// it is meant to render inside Settings (research.md decision 9).
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/state'

interface BrandWatermarkProps {
  /** 'live': the real, responsively-clamped corner mark. 'preview': a small, fixed-size
   *  rendering meant to sit inline inside a bordered preview container in Settings. */
  variant: 'live' | 'preview'
}

export function BrandWatermark({ variant }: BrandWatermarkProps) {
  const watermarkEnabled = useSettingsStore((s) => s.settings.watermarkEnabled)
  if (!watermarkEnabled) return null
  return (
    <div
      aria-hidden
      className={cn('watermark-mark pointer-events-none', variant === 'live' ? 'watermark-mark--live' : 'size-24')}
    />
  )
}
