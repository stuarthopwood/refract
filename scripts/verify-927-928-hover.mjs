// Item 5 (T3, hover): real CDP hover-state verification for the composer's ghost triggers
// (Approval pill, Model, Reasoning, Attach) -- split out of `verify-927-928-quiet-composer.mjs`
// (file-size #806 ratchet) as its own concern, the same way `contrast-math.mjs`/
// `verify-tauri-cdp.mjs` already separate colour math and CDP driving from that script's own
// per-theme assertion flow.
import { sleep } from './verify-tauri-cdp.mjs';

/** Moves the real mouse to a neutral point (the window's own top-left corner, never any
 * composer trigger) BETWEEN hover reads -- without this, the previous trigger's own hover state
 * can still be active (CDP never auto-fires a `mouseleave`) when the next one is read, making a
 * stale hover background misread as the new trigger's own. */
export async function moveMouseAway(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
  await sleep(30);
}

/** A REAL CDP `mouseMoved` to the trigger's own centre (verified against
 * `document.elementFromPoint` hitting the element or a descendant, never a scripted `:hover`
 * class toggle) -- settles animations first (M3), then reads `cursor` and `background-color`.
 * An ENABLED ghost trigger must show the pointer cursor and a background that differs from its
 * own resting value (a faint fill, decision 4a); an `aria-disabled` one must show `not-allowed`
 * and NO fill change. */
async function readGhostHoverStyle(cdp, finderExpr) {
  const rect = await cdp.evaluate(`(() => {
    const el = ${finderExpr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) return null;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(50);
  await cdp.evaluate(`document.getAnimations().forEach((a) => a.finish())`);
  return cdp.evaluate(`(() => {
    const el = ${finderExpr};
    if (!el) return null;
    const hit = document.elementFromPoint(${rect.x}, ${rect.y});
    const hitMatches = hit === el || el.contains(hit);
    const cs = getComputedStyle(el);
    return { hitMatches, ariaDisabled: el.getAttribute('aria-disabled') === 'true', cursor: cs.cursor, backgroundColor: cs.backgroundColor };
  })()`);
}

/** Hovers every `[name, finderExpr]` pair in `targets` (keyed identically to `ghostResting`'s
 * own keys, e.g. `readGhostControlRestingStyles`'s `approvalPill`/`modelPicker`/
 * `reasoningPicker`/`attachButton`) and pushes a `findings`/`failures` line per assertion.
 * Returns `true` if any trigger was genuinely `aria-disabled` during this call, so the caller
 * can fold that into its own run-wide "was this ever exercised" reasoning. */
export async function assertGhostHoverStates(cdp, themeName, targets, ghostResting, findings, failures) {
  let anyDisabled = false;
  for (const [name, finderExpr] of targets) {
    await moveMouseAway(cdp);
    const hover = await readGhostHoverStyle(cdp, finderExpr);
    if (!hover) {
      failures.push(`${themeName}: ${name} not found for hover (target missing).`);
      continue;
    }
    if (!hover.hitMatches) {
      failures.push(`${themeName}: ${name} hover mouseMoved point did not land on it (document.elementFromPoint mismatch) -- cannot trust the hover read.`);
      continue;
    }
    const restingBackground = ghostResting?.[name]?.backgroundColor;
    if (hover.ariaDisabled) {
      anyDisabled = true;
      if (hover.cursor !== 'not-allowed') failures.push(`${themeName}: ${name} is aria-disabled but hover cursor is ${hover.cursor}, expected not-allowed.`);
      else findings.push(`${themeName}: ${name} (aria-disabled) shows cursor not-allowed on hover.`);
      if (restingBackground !== undefined && hover.backgroundColor !== restingBackground) failures.push(`${themeName}: ${name} is aria-disabled but its hover background (${hover.backgroundColor}) differs from resting (${restingBackground}) -- a disabled ghost trigger must show no fill.`);
      else findings.push(`${themeName}: ${name} (aria-disabled) shows no hover fill change, as required.`);
    } else {
      if (hover.cursor !== 'pointer') failures.push(`${themeName}: ${name} hover cursor is ${hover.cursor}, expected pointer.`);
      else findings.push(`${themeName}: ${name} shows cursor pointer on hover.`);
      if (restingBackground !== undefined && hover.backgroundColor === restingBackground) failures.push(`${themeName}: ${name} hover background (${hover.backgroundColor}) is identical to resting -- expected a faint fill on hover (decision 4a).`);
      else findings.push(`${themeName}: ${name} hover background (${hover.backgroundColor}) differs from resting (${restingBackground}), the faint fill decision 4a requires.`);
    }
  }
  await moveMouseAway(cdp);
  return anyDisabled;
}
