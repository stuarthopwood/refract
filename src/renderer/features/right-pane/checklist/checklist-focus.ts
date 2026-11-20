/** Which checklist a panel is showing, and for which Session. */
export interface PanelView {
  sessionId: string | null
  checklistId: string | null
}

/** True when the same Session swapped one checklist for another; a Session change is not a replacement. */
export const wasReplaced = (previous: PanelView, next: PanelView): boolean =>
  previous.sessionId === next.sessionId && previous.checklistId !== null && next.checklistId !== null && previous.checklistId !== next.checklistId

/** Whether the focused element sits in the region; read before a replacement unmounts it, after which focus falls to the body. */
export const containsFocus = (region: Pick<Node, 'contains'> | null, active: Node | null): boolean => region !== null && region.contains(active)

/** A replacement pulls focus to the panel only when focus was inside, so a developer typing elsewhere is never interrupted. */
export const focusFollowsReplace = (previous: PanelView, next: PanelView, focusWasInside: boolean): boolean => focusWasInside && wasReplaced(previous, next)
