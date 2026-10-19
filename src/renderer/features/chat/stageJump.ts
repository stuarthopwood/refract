// Split out of `SubagentChainRow.tsx` (file-size baseline, #806 "no god files"): issue #1008
// item 2's "Go to Stage N" jump contract -- the shared DOM id convention every Stage row's own
// `CollapsedLine` carries, the top-margin constant, and the context `ChainStageLine` (a SIBLING
// of the Stage row it targets, never its parent -- no React ref to use) reaches up through to
// find the one function that can actually move the viewport and open the row: `Transcript.tsx`'s
// own `jumpToStageRow`.
//
// Gate round 2 fix (issue #1008, Main 2026-10-18, Decided -- falsified live): this file used to
// ALSO hold `jumpToStage`/`settleScrollToRow`, a plain DOM function with its own short, bounded
// settle loop. On a turn that stays unsettled (a permanently failed Stage, FR-068),
// `MessageScrollerProvider`'s own sticky follow-bottom auto-scroll stayed engaged the whole time
// -- `Transcript.tsx` only ever suppresses it via `autoScrollSuppressed`, LOCAL React state this
// plain function could never reach -- so the jumped-to Stage's own expansion (itself a DOM
// mutation) kept re-triggering the vendored scroller's own re-snap-to-end, which this function's
// own settle loop lost against every single animation frame (a live `scrollTop` trace proved it
// pinned at `scrollHeight - clientHeight` from frame 0). Moved into `Transcript.tsx` itself, which
// DOES hold that state and already has a proven `runScrollSettleLoop` engine (`scrollLanding.ts`)
// to reuse -- see `jumpToStageRow`'s own jsdoc there for the full fix.
import * as React from 'react'

/** The DOM id every Stage row's own `CollapsedLine` carries, and the one key `jumpToStageRow`
 * (`Transcript.tsx`) looks it up by (`document.getElementById`, not a CSS selector -- a Stage's
 * own `group.id` (e.g. `stage:<itemId>`) is never parsed or escaped this way). Gate round 1 fix
 * (issue #1008, item 4, Medium): scoped by `sessionId` too -- a split pane can show two different
 * Sessions at once, each with its own Transcript tree; a bare `group.id` alone could collide with
 * another Session's own Stage id and produce an invalid duplicate DOM id (two elements with the
 * same `id` is a real HTML violation, not merely an ambiguous lookup). */
export function stageRowDomId(sessionId: string | null, stageId: string): string {
  return `stage-row:${sessionId ?? 'none'}:${stageId}`
}

// Gate round 1 fix (issue #1008, item 2, Medium): the small top margin the jumped-to row lands
// at, instead of dead-centring it -- Decided (Skippy, delegated by Stuart 2026-10-18): align to
// the top, matching how a reader's eye naturally starts reading a newly-revealed row from its
// own header down, not from its middle.
export const JUMP_SCROLL_TOP_MARGIN_PX = 16

/** Provided by `Transcript.tsx` (its own `jumpToStageRow`, which closes over `viewportRef`,
 * `scrollerRootRef`, and `autoScrollSuppressed`'s setter -- none of which `ChainStageLine` can
 * reach, being a sibling of the Stage row it targets, not a parent). `null` outside a `Transcript`
 * (should not normally happen; `ChainStageLine` only ever renders inside one). `ChainStageLine`
 * reads this via `React.useContext` and falls back to a plain, non-interactive span when it is
 * `null` or `sessionId` itself is `null` (issue #1008 gate round 2 item 4: without a real
 * `sessionId` there is no persisted store to record a manual-open against, so a clickable "jump"
 * that cannot actually count as the user's own open would be misleading). */
export const JumpToStageContext = React.createContext<((stageId: string) => void) | null>(null)
