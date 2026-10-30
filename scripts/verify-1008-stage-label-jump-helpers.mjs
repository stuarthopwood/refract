// Finder expressions and viewport-proof helpers shared by verify-1008-stage-label-jump.mjs (#806 size cap).

// The jump button's accessible name is "Go to <speech heading>" (middle dot swapped for ", ").
// JSON.stringify the whole selector so an apostrophe in the title can't break the quoted literal.
export function jumpButtonExpr(titleText) {
  const ariaLabel = `Go to ${titleText.replace(' \u00b7 ', ', ')}`;
  const cssValue = ariaLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `document.querySelector(${JSON.stringify(`[aria-label="Transcript"] button[aria-label="${cssValue}"]`)})`;
}

/** Proves a real on-screen extent; mere DOM presence isn't enough because `content-visibility:auto` never removes nodes. */
export function viewportRectExpr(triggerExpr) {
  return `(() => { const el = (${triggerExpr}); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, viewportHeight: window.innerHeight }; })()`;
}

export function rectIsInViewport(rect) {
  return !!rect && rect.height > 0 && rect.bottom > 0 && rect.top < rect.viewportHeight;
}

// Bounds alone passed falsely after the mouse jump: elementFromPoint hit the chain row's own "Go to
// Stage 4" button, not the real stage row. So hit-test the row's centre after a settle delay, and
// click the button directly (no pre-click scrollIntoView, which clobbered the smooth scrollTo).
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

// Scrolls to the end so the early stages start off-screen, giving each jump a reproducible "before" state.
export function scrollTranscriptToEnd(cdp) {
  return cdp.evaluate(`(() => { const v = document.querySelector('[aria-label="Transcript"]'); if (v) v.scrollTop = v.scrollHeight; })()`);
}
