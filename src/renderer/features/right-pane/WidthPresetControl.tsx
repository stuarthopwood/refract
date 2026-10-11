// The pane's non-drag resize alternative (spec 013 FR-025, WCAG 2.5.7): three buttons calling a
// passed-in `resize` callback with the pane's three named widths. Owns its own row (height,
// border-t divider, padding) so every call site -- the single-panel title row, the two-tab bar,
// and the 0-panel launcher (gate remediation, round 1: US6 scenario 1 and FR-025/SC-008 say "the
// pane is open", never "a panel is open" -- the launcher is a pane-open state too, closing the
// last tab or dragging the pane open both reach it, and it had a drag handle but no non-drag
// alternative until this fix) -- renders `<WidthPresetControl resize={resize} />` with no extra
// wrapper of its own, instead of each repeating the same row markup (DRY; the row previously
// lived at each of the two call sites separately, now exists once here).
//
// Gate remediation (round 1, A11y1/Verif1 Medium): the currently-applied width has no visible
// marker, so a sighted or screen-reader user has no way to tell Default from a hand-dragged width
// that happens to be near Default. `aria-pressed` (matching the preset to the store's own
// `widthPx`, rounded since a drag can land on a fractional pixel) plus the same
// `aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:border-foreground` utility
// `IconRail.tsx`'s own toggle buttons already use (no new token; `check:theme-contrast`'s existing
// pairs cover every one of these) marks the active preset without adding a second indicator reviewers
// would have to maintain in sync.
import { Button } from '@/components/ui/button'
import { RIGHT_PANE_DEFAULT_WIDTH_PX, RIGHT_PANE_MAX_WIDTH_PX, RIGHT_PANE_MIN_WIDTH_PX, useRightPaneStore } from '@/state/right-pane-store'

interface WidthPresetControlProps {
  resize(widthPx: number): void
}

const PRESETS: Array<{ label: string; widthPx: number }> = [
  { label: 'Min', widthPx: RIGHT_PANE_MIN_WIDTH_PX },
  { label: 'Default', widthPx: RIGHT_PANE_DEFAULT_WIDTH_PX },
  { label: 'Max', widthPx: RIGHT_PANE_MAX_WIDTH_PX }
]

export function WidthPresetControl({ resize }: WidthPresetControlProps) {
  const widthPx = useRightPaneStore((s) => s.widthPx)
  return (
    <div className="no-drag-region flex h-10 shrink-0 items-center border-t border-border px-2">
      <div role="group" aria-label="Pane width" className="flex items-center gap-1">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={Math.round(widthPx) === preset.widthPx}
            className="aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:border-foreground"
            onClick={() => resize(preset.widthPx)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
