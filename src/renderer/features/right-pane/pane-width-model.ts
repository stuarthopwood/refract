// Spec 137 FR-014, FR-022 to FR-024 (#2075; H3, M6): the pure rules behind the right pane's width
// menus and resize handle, so they are testable without a DOM.
import { RIGHT_PANE_MIN_WIDTH_PX } from '@/state/right-pane-store'

export const CHAT_MIN_WIDTH_PX = 360

// The panel ids App.tsx gives `ResizablePanel`; the library writes them onto the panel elements.
const SESSION_LIST_DOM_ID = 'session-list'
const RIGHT_PANE_DOM_ID = 'right-pane'
const PANEL_GROUP_SELECTOR = '[data-slot="resizable-panel-group"]'

export interface PaneLayoutWidths {
  groupWidthPx: number
  sessionListPx: number
}

/** Null when the layout cannot be measured; callers then never block a choice on a guess. */
export function measurePaneLayout(): PaneLayoutWidths | null {
  const group = document.getElementById(RIGHT_PANE_DOM_ID)?.closest(PANEL_GROUP_SELECTOR)
  const sessionList = document.getElementById(SESSION_LIST_DOM_ID)
  if (!group || !sessionList) return null
  return { groupWidthPx: group.clientWidth, sessionListPx: sessionList.offsetWidth }
}

/** True when the right pane can have `widthPx` while chat keeps its minimum. */
export function widthFits(widthPx: number, layout: PaneLayoutWidths | null): boolean {
  return layout === null || layout.groupWidthPx - layout.sessionListPx - CHAT_MIN_WIDTH_PX >= widthPx
}

/** Showing chat in a window too narrow for chat plus the 240 px floor closes the pane (M6). */
export function closesPaneOnShowChat(layout: PaneLayoutWidths | null): boolean {
  return !widthFits(RIGHT_PANE_MIN_WIDTH_PX, layout)
}

/** The radio value that marks the current width; empty when it is not a preset or chat hides the pane's own width. */
export function currentChoiceValue(input: { open: boolean; chatHidden: boolean; widthPx: number; presets: readonly number[] }): string {
  const rounded = Math.round(input.widthPx)
  return input.open && !input.chatHidden && input.presets.includes(rounded) ? String(rounded) : ''
}

export function choiceDisabled(input: { widthPx: number; canAct: boolean; layout: PaneLayoutWidths | null }): boolean {
  return !input.canAct || !widthFits(input.widthPx, input.layout)
}

/** While chat is hidden the pane's width is the remainder, so the name never reports `widthPx` (FR-024). */
export function resizeHandleName(input: { open: boolean; chatHidden: boolean; widthPx: number }): string {
  if (input.chatHidden) return 'Resize right pane, unavailable while chat is hidden'
  return input.open ? `Resize right pane, ${Math.round(input.widthPx)} pixels wide` : 'Resize right pane, collapsed'
}
