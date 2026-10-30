// Real CDP hover-state checks for the composer's ghost triggers, split out of the quiet-composer script.
import { sleep } from './verify-tauri-cdp.mjs';

/** Moves the mouse to the window corner between reads: CDP never fires `mouseleave`, so a stale hover would leak into the next read. */
export async function moveMouseAway(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
  await sleep(30);
}

/** Hovers the trigger with a real mouse move and reads its cursor and background; enabled must fill, `aria-disabled` must show `not-allowed` with no fill. */
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

/** Hovers each ghost trigger in `targets` and records a finding or failure per assertion; returns true if any was `aria-disabled`. */
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
