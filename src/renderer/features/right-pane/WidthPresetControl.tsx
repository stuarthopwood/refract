// The pane's non-drag resize alternative (spec 013 FR-025, WCAG 2.5.7): three buttons calling a
// passed-in `resize` callback with the pane's three named widths. Pure/dumb -- wired into the
// shell's header (via the `ResizablePanel` ref's own `.resize()`) by `PanelTabBar.tsx`, called
// from `App.tsx`'s own ref (tasks.md T029, PR4); this component only renders the buttons.
import { Button } from '@/components/ui/button'
import { RIGHT_PANE_DEFAULT_WIDTH_PX, RIGHT_PANE_MAX_WIDTH_PX, RIGHT_PANE_MIN_WIDTH_PX } from '@/state/right-pane-store'

interface WidthPresetControlProps {
  resize(widthPx: number): void
}

const PRESETS: Array<{ label: string; widthPx: number }> = [
  { label: 'Min', widthPx: RIGHT_PANE_MIN_WIDTH_PX },
  { label: 'Default', widthPx: RIGHT_PANE_DEFAULT_WIDTH_PX },
  { label: 'Max', widthPx: RIGHT_PANE_MAX_WIDTH_PX }
]

export function WidthPresetControl({ resize }: WidthPresetControlProps) {
  return (
    <div role="group" aria-label="Pane width" className="flex items-center gap-1">
      {PRESETS.map((preset) => (
        <Button key={preset.label} type="button" variant="outline" size="xs" onClick={() => resize(preset.widthPx)}>
          {preset.label}
        </Button>
      ))}
    </div>
  )
}
