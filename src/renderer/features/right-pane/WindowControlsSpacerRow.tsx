import { RAIL_WIDTH_PX } from '../../../shared/layout'

// Shared piece of the pane header (spec 013 FR-011): reserves the window-controls corner's
// width, `aria-hidden` throughout since nothing in it is interactive. Used above the tab strip
// (PanelTabBar.tsx) and above the pane's content in the 0-panel launcher (RightPaneShell.tsx).
//
// The right-pane rail's own 48px (`RAIL_WIDTH_PX`) column: the native caption-button cluster
// is wider than that and overlaps both the rail's own top spacer and the pane header's corner, so
// only the width past the rail needs reserving here, and only down to 0 (never negative).
export const WINDOW_CONTROLS_SPACER_STYLE = { width: `max(0px, calc(100vw - env(titlebar-area-width, 100vw) - ${RAIL_WIDTH_PX}px))` }

export function WindowControlsSpacerRow() {
  return (
    <div aria-hidden className="drag-region titlebar-surface flex h-10 shrink-0 items-center px-2">
      <div className="no-drag-region ml-auto shrink-0" style={WINDOW_CONTROLS_SPACER_STYLE} />
    </div>
  )
}
