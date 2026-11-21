/** Whether the focused element sits in the region. */
export const containsFocus = (region: Pick<Node, 'contains'> | null, active: Node | null): boolean => region !== null && region.contains(active)

/** A blur that moves focus out of the region, or drops it to nothing while the element is still mounted; an element unmounted mid-focus is not a departure. */
export const blurLeavesRegion = (region: Pick<Node, 'contains'>, related: Node | null, target: Pick<Node, 'isConnected'>): boolean =>
  target.isConnected && !region.contains(related)

interface RefocusInput {
  sameSession: boolean
  focusWasInside: boolean
  focusStillInside: boolean
}

/** An update that unmounted the focused item (removed or replaced) drops focus to the body; pull it back to the panel, but never on a Session change or when focus was elsewhere. */
export const shouldRefocus = ({ sameSession, focusWasInside, focusStillInside }: RefocusInput): boolean => sameSession && focusWasInside && !focusStillInside
