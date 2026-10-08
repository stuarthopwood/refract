// Issue #510 slice 4 (PLAN.md row A0): "Load earlier" instead of rendering every turn a long
// Session ever had. The real cost of a 48 MB Conversation is DOM/render volume in the renderer,
// not a second network trip -- main already fetches the complete transcript in bounded pages
// (`fetchAllMessages.ts`) before this Session is marked attached, so this is a pure, client-side
// window over data already fully in `useTranscriptStore`, never a second IPC round trip per
// click (docs/spike/FINDINGS.md item 47's own "Engineering decision").
export const INITIAL_VISIBLE_TURN_COUNT = 50;

export interface TurnWindow<T> {
  visible: T[];
  hiddenCount: number;
}

/** `revealed` is per-Session UI state the caller owns (reset when the Session changes). Always
 * keeps the LAST `INITIAL_VISIBLE_TURN_COUNT` turns visible (the running/most recent turn must
 * never be hidden); "Load earlier" reveals everything at once rather than one more page at a
 * time, since the data is already in memory and there is nothing further to fetch. */
export function windowTranscriptTurns<T>(turns: T[], revealed: boolean): TurnWindow<T> {
  if (revealed || turns.length <= INITIAL_VISIBLE_TURN_COUNT) {
    return { visible: turns, hiddenCount: 0 };
  }
  return {
    visible: turns.slice(turns.length - INITIAL_VISIBLE_TURN_COUNT),
    hiddenCount: turns.length - INITIAL_VISIBLE_TURN_COUNT,
  };
}

/** Quality-gate fix (test-reviewer, Medium, cycle 3, 2026-10-08): the scroll-anchor arithmetic
 * `Transcript.tsx`'s "Load earlier" reveal depends on, pulled out so it is unit-testable without
 * a real DOM/jsdom (this project has no jsdom test environment anywhere yet). `anchor` is the
 * distance-from-end (`scrollHeight - scrollTop`) recorded BEFORE the reveal; once the newly
 * revealed turns have pushed `scrollHeight` out, this is the `scrollTop` that restores the same
 * distance from the end, so the view never jumps to the oldest newly-revealed content. */
export function restoreScrollTop(newScrollHeight: number, anchor: number): number {
  return newScrollHeight - anchor;
}

/** Quality-gate fix (test-reviewer, Medium, cycle 3): the "Load earlier" announcement text,
 * pulled out so its singular/plural wording is unit-tested directly. */
export function loadEarlierAnnouncement(revealedCount: number): string {
  return `Loaded ${revealedCount} earlier turn${revealedCount === 1 ? '' : 's'}.`;
}
