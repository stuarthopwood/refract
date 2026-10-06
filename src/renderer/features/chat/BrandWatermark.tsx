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
  // Quality-gate remediation (code-reviewer/ui-architect, Medium): `-z-10` on the 'live' variant
  // (research.md decision 8 -- previously undone in code) so this absolutely-positioned mark
  // paints BEHIND its normal-flow sibling content (App.tsx's no-pane-open text, this ChatPane's
  // own `!session` Empty state, and the real transcript) instead of over it -- every mount point
  // already establishes its own stacking context (`isolate` or `[container-type:size]`'s implied
  // containment), so the mark stays visibly behind its own siblings rather than escaping further
  // up and disappearing under something else entirely.
  return (
    <div
      aria-hidden
      className={cn('watermark-mark pointer-events-none', variant === 'live' ? 'watermark-mark--live -z-10' : 'size-24')}
    />
  )
}
