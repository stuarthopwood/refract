// Shared piece of the pane header (spec 013 FR-011): reserves the window-controls corner's
// width, nothing interactive inside it -- `aria-hidden` throughout, since it carries no content
// an assistive technology user would ever need to reach. Used above the tab strip's own Row 2
// (PanelTabBar.tsx) and above the width-preset row in the 0-panel launcher state
// (RightPaneShell.tsx), so the reservation itself exists in exactly one place instead of being
// duplicated per header variant.
//
// Gate remediation: the rail sits in its own 40px (`2.5rem`) column to the right of the pane, but
// the native caption-button cluster is wider than that (about 138px) and overlaps both the rail's
// top (handled by `IconRail.tsx`'s own vertical spacer) and the pane header's own top-right corner
// -- only the REMAINING width past the rail needs reserving here, or the pane would reserve the
// full caption width a second time. Clamped at 0 so a window narrower than the caption cluster
// never produces a negative width.
export const WINDOW_CONTROLS_SPACER_STYLE = { width: 'max(0px, calc(100vw - env(titlebar-area-width, 100vw) - 2.5rem))' }

export function WindowControlsSpacerRow() {
  return (
    <div aria-hidden className="drag-region flex h-10 items-center px-2">
      <div className="no-drag-region ml-auto shrink-0" style={WINDOW_CONTROLS_SPACER_STYLE} />
    </div>
  )
}
