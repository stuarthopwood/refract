import * as React from 'react'

/** DOM id of a Stage row; scoped by session so split panes never share an id. */
export function stageRowDomId(sessionId: string | null, stageId: string): string {
  return `stage-row:${sessionId ?? 'none'}:${stageId}`
}

/** Gap kept above a row after a jump, so it is read from its header. */
export const JUMP_SCROLL_TOP_MARGIN_PX = 16

/** Provided by `Transcript`, which owns the scroll state a sibling row cannot reach. */
export const JumpToStageContext = React.createContext<((stageId: string) => void) | null>(null)
