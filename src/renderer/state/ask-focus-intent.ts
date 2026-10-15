// #572 gate round 2 (D17, code review N1 / a11y H3 / architect H-a): focus-after-resolution
// handoff for the Ask card. `AskCard`'s own local `resolved` render branch can never be trusted
// to receive focus, because `Transcript.tsx` swaps the whole `RequestCard`/`AskCard` subtree for
// `ResolvedRequestSummary` or `AskQuestionRow` the moment the pending request's own
// `item.resolved`/`askItem` state changes -- a PARENT-level swap driven by a store update, not
// this component's own unmount cleanup, so by the time (if ever) `AskCard`'s own effect runs the
// node it focused is already gone. The intent has to survive that swap in something outside
// React's own tree: a plain module-scoped `Set`, not a store, since nothing here ever needs to
// *re-render* on a change -- only read once, imperatively, the moment the resolved row mounts.
//
// Two-stage handoff: the bridging `ResolvedRequestSummary` row can itself be superseded later by
// `AskQuestionRow` once the matching `ask` tool item lands, in a SEPARATE, later commit from the
// one that first resolved the request -- so `ResolvedRequestSummary` re-marks the SAME intent on
// its own unmount if it still holds focus, passing the baton forward instead of dropping it.
const pending = new Set<string>();

/**
 * Record that focus was inside the Ask card for `requestId` at the moment it resolved (Submit,
 * Cancel, or an externally-driven OMP cancel/timeout that unmounts the card out from under the
 * user), or that a bridging row that already claimed it is itself about to be superseded while
 * still focused. Safe to call more than once for the same id; a no-op for `undefined` (every
 * caller that is not an `ask` request at all -- approvals, the fallback question path -- never
 * has an id anyone marked, so this stays harmless there).
 */
export function markAskFocusPending(requestId: string | undefined): void {
  if (!requestId) return;
  pending.add(requestId);
}

/**
 * Call once from whichever row ends up rendering the resolution (`ResolvedRequestSummary`'s own
 * bridge row, or `AskQuestionRow`'s expand trigger once the matching `ask` tool item lands) when
 * it mounts. Returns whether `requestId` had a pending intent, and clears it either way -- a
 * later, unrelated mount of the same row type must never steal focus.
 */
export function consumeAskFocusPending(requestId: string | undefined): boolean {
  if (!requestId) return false;
  const had = pending.has(requestId);
  pending.delete(requestId);
  return had;
}
