import { focusPaneContent, isFocusStranded } from '@/lib/focus';

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
//
// Gate round 3 (unanimous High/Medium, all three reviewers): keyed by `${sessionId}:${requestId}`,
// not the bare request id -- OMP's own ids are per-process random hex and vanishingly unlikely to
// collide across Sessions in practice, but keying on both makes that impossible by construction
// rather than by luck. Callers build the composite key themselves (there is nothing to validate
// here); `markAskFocusPendingWithFallback` below is the one place that both arms an intent AND
// gives it a bounded lifetime, shared by `AskCard`'s own unmount handoff and
// `ResolvedRequestSummary`'s bridge re-arm, so a stale re-mark (round 3 Medium: a resolved row
// focused by click, then unmounted for an unrelated reason such as a Session switch, left its
// intent in this `Set` forever, ready to steal focus whenever a row with that id next mounted)
// can no longer outlive one animation frame on EITHER path.
const pending = new Set<string>();

/**
 * Record that focus was inside the Ask card for `key` at the moment it resolved (Submit, Cancel,
 * or an externally-driven OMP cancel/timeout that unmounts the card out from under the user), or
 * that a bridging row that already claimed it is itself about to be superseded while still
 * focused. Safe to call more than once for the same key. A no-op for `undefined` (every caller
 * that is not an `ask` request at all -- approvals, the fallback question path -- never has a key
 * anyone marked, so this stays harmless there).
 */
export function markAskFocusPending(key: string | undefined): void {
  if (!key) return;
  pending.add(key);
}

/**
 * Call once from whichever row ends up rendering the resolution (`ResolvedRequestSummary`'s own
 * bridge row, or `AskQuestionRow`'s expand trigger once the matching `ask` tool item lands) when
 * it mounts. Returns whether `key` had a pending intent, and clears it either way -- a later,
 * unrelated mount of the same row type must never steal focus.
 */
export function consumeAskFocusPending(key: string | undefined): boolean {
  if (!key) return false;
  const had = pending.has(key);
  pending.delete(key);
  return had;
}

/**
 * Mark `key` pending, then give whichever row might claim it (via `consumeAskFocusPending` in a
 * `useLayoutEffect`, so the ordering against this function's own `requestAnimationFrame` below is
 * explicit) exactly one animation frame to do so before this same call expires the intent itself
 * -- `consumeAskFocusPending` inside the callback both checks AND clears, so whether some row
 * claimed it first (this becomes a no-op) or nothing did (this claims it instead and runs the
 * fallback) the intent never outlives one frame either way. Falls back to rescuing focus into the
 * Session's own chat pane (`focusPaneContent`), but ONLY if focus is actually stranded there by
 * then (`isFocusStranded`, checked globally, not scoped to this one pane, per the gate's own
 * instruction) -- never stealing it from somewhere it is still validly resting (another pane, the
 * composer, a different Session). Shared by `AskCard`'s own unmount handoff and
 * `ResolvedRequestSummary`'s bridge re-arm, so both expire exactly the same way.
 */
export function markAskFocusPendingWithFallback(key: string | undefined, sessionId: string | undefined): void {
  if (!key) return;
  markAskFocusPending(key);
  requestAnimationFrame(() => {
    if (!consumeAskFocusPending(key)) return;
    const pane = sessionId ? document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"]`) : null;
    if (isFocusStranded(document.activeElement, pane)) focusPaneContent(pane);
  });
}
