// The pane's non-drag resize alternative (spec 013 FR-025, WCAG 2.5.7): three buttons calling a
// passed-in `resize` callback with the pane's three named widths. The currently-applied width is
// marked by swapping each button's own `variant` (`default` when pressed, `outline` otherwise)
// plus `aria-pressed`, the same pattern `ReviewDialog.tsx`'s verdict buttons already use -- an
// `aria-pressed:*` utility on the `outline` variant loses to that variant's own later
// `dark:border-input dark:bg-input/30` selectors and never paints. Owns its own row (height,
// border, padding) so every call site -- the launcher, the single-panel title row, the two-tab
// bar -- renders `<WidthPresetControl resize={resize} />` with no wrapper of its own.
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
        {PRESETS.map((preset) => {
          const pressed = Math.round(widthPx) === preset.widthPx
          return (
            <Button
              key={preset.label}
              type="button"
              variant={pressed ? 'default' : 'outline'}
              size="xs"
              aria-pressed={pressed}
              onClick={() => resize(preset.widthPx)}
            >
              {preset.label}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
