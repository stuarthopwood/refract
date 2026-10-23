// Split out of `verify-1008-stage-label-jump.mjs` (file-size cap, #806 "no god files"): the
// finder expressions and viewport-proof helpers that script's own jump checks (both the mouse
// jump to Stage 4 and the keyboard jump to Stage 3, settled-turn and still-streaming alike) share.

// Issue #1008 item 2/gate round 1 item 6: the jump button's own accessible name is "Go to
// <speech heading>" (`ChainStageLine.tsx`'s own `speechHeading`, `stageHeading(...,  true)`) --
// the SAME visible "·" form every `STAGE*_TITLE` constant already carries, with "·" swapped for
// ", " (the identical transform `stageHeading`'s own `forSpeech` branch applies). Never found at
// all on `origin/main`, where this label is still a plain, non-interactive `<span>`.
// Gate round 2 fix (falsified live, item 5): STAGE10_BORDERLINE_TITLE's own text contains an
// apostrophe ("brief's") -- the old version embedded `ariaLabel` directly inside an OUTER
// single-quoted JS string, so that apostrophe closed the string early, a syntax error the
// instant this title was ever actually waited on (the exact same shape of bug `titleSelector`'s
// own doc comment, `verify-941-stage-naming-helpers.mjs`, already fixed once for `titleText`
// itself). Fixed the same way: escape the CSS attribute VALUE first, then `JSON.stringify` the
// WHOLE `querySelector` argument once, so no apostrophe or quote inside `titleText` can ever
// break out of a hand-built quoted literal again.
export function jumpButtonExpr(titleText) {
  const ariaLabel = `Go to ${titleText.replace(' \u00b7 ', ', ')}`;
  const cssValue = ariaLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `document.querySelector(${JSON.stringify(`[aria-label="Transcript"] button[aria-label="${cssValue}"]`)})`;
}

/** Bounds-based "is this genuinely in the viewport" proof: a real, positive on-screen extent
 * inside the window's own viewport -- not merely present in the DOM, which
 * `message-scroller.tsx`'s own `content-visibility:auto` never removes regardless of scroll
 * position (there is no windowing-library virtualizer in this codebase to defeat). */
export function viewportRectExpr(triggerExpr) {
  return `(() => { const el = (${triggerExpr}); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, viewportHeight: window.innerHeight }; })()`;
}

export function rectIsInViewport(rect) {
  return !!rect && rect.height > 0 && rect.bottom > 0 && rect.top < rect.viewportHeight;
}

// Gate round 2 (falsified live, root-caused via ancestor-chain + elementFromPoint diagnostics,
// head 988479c): `cdp.waitFor(isInViewportExpr(...))` polled a bounds-only
// `getBoundingClientRect()` test and NEVER saw Stage 4's own row satisfy it after the MOUSE jump,
// while the keyboard jump (Stage 3) always did. A screenshot taken right after looked like Stage
// 4's row was in view -- it wasn't: `document.elementFromPoint` at that exact pixel resolved to
// the CHAIN row's OWN "Go to Stage 4" button (same label text, rendered inline in the
// always-open chain body), not Stage 4's real `StageGroupRow` elsewhere in the transcript. The
// real cause: `clickScrolled` (`verify-941-stage-naming-helpers.mjs`) does its own
// `el.scrollIntoView({block:'center'})` on the chain's button BEFORE dispatching the click --
// redundant here, since `scrollTranscriptToEnd` already puts that button on screen -- and this
// extra scroll animation was clobbering the OLD `jumpToStage`'s OWN smooth `scrollTo`, leaving the
// viewport pinned at (or snapping back to) the transcript's max scroll instead of Stage 4's real
// row. The keyboard path never calls `clickScrolled`, so it never raced this. Fixed by clicking
// the "Go to Stage 4" button directly (`cdp.click`, no pre-click scrollIntoView) since it is
// already on screen after `scrollTranscriptToEnd`. `viewportHitTestExpr` stays as the proof
// mechanism for both jumps: a fixed settle delay, then one `elementFromPoint` hit test at the
// row's own centre -- the same kind of proof a screenshot gives, but asserted, not eyeballed.
export function viewportHitTestExpr(triggerExpr) {
  return `(() => {
    const el = (${triggerExpr});
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const inBounds = r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    const cx = r.left + r.width / 2;
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
    const hitEl = document.elementFromPoint(cx, cy);
    const hit = !!hitEl && (hitEl === el || el.contains(hitEl) || hitEl.contains(el));
    return { found: true, inBounds, hit, rect: { top: r.top, bottom: r.bottom, height: r.height, viewportHeight: window.innerHeight } };
  })()`;
}

// Gate round 1 item 8: scrolls ONLY the transcript's own viewport to its own end -- Stage 1/
// Stage 3 sit near the top of this ten-Stage turn, so from the end this is a hard, reproducible
// off-screen baseline for each jump's own "before" assertion, not an assumption about where the
// app happens to leave the scroll position after a turn settles.
export function scrollTranscriptToEnd(cdp) {
  return cdp.evaluate(`(() => { const v = document.querySelector('[aria-label="Transcript"]'); if (v) v.scrollTop = v.scrollHeight; })()`);
}
