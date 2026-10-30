import { RAIL_WIDTH_PX } from '../../../shared/layout'

// Reserves the window-controls corner's width; `aria-hidden` as nothing in it is interactive.
export const WINDOW_CONTROLS_SPACER_STYLE = { width: `max(0px, calc(100vw - env(titlebar-area-width, 100vw) - ${RAIL_WIDTH_PX}px))` }

export function WindowControlsSpacerRow() {
  return (
    <div aria-hidden className="drag-region titlebar-surface flex h-10 shrink-0 items-center px-2">
      <div className="no-drag-region ml-auto shrink-0" style={WINDOW_CONTROLS_SPACER_STYLE} />
    </div>
  )
}
