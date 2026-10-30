// Helpers split from `verify-1077-agent-goal.mjs` to keep it under the file-size cap (#806).
import path from 'node:path';
import { stageContentSelector } from './verify-941-stage-naming-helpers.mjs';

export function toggleButtonSelector(stageTitle) {
  return `(${stageContentSelector(stageTitle)})?.querySelector('button[aria-expanded][aria-controls]')`;
}

export function toggleContentSelector(stageTitle) {
  return `(() => { const btn = (${toggleButtonSelector(stageTitle)}); if (!btn) return null; return document.getElementById(btn.getAttribute('aria-controls')); })()`;
}

export function goalParagraphSelector(stageTitle) {
  return `(${stageContentSelector(stageTitle)})?.querySelector('p.line-clamp-3')`;
}

/** Scrolls the row clear of the chat `<header>` before clicking: `scrollIntoView` centring clamps
 * at scrollTop 0 near the top of a short conversation and leaves the row under the header. */
export async function clickClearOfHeader(cdp, finderExpr) {
  await cdp.waitFor(`!!(${finderExpr})`, { timeoutMs: 15_000, label: `clickClearOfHeader: waiting for ${finderExpr}` });
  await cdp.evaluate(`(() => {
    const el = (${finderExpr});
    if (!el) return;
    const header = document.querySelector('header');
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    const viewport = el.closest('[data-slot="message-scroller-viewport"]');
    if (!viewport) return;
    const rect = el.getBoundingClientRect();
    const safeTop = headerBottom + 8;
    const safeBottom = window.innerHeight - 8;
    const safeCenter = (safeTop + safeBottom) / 2;
    const elementCenter = rect.top + rect.height / 2;
    viewport.scrollTop += elementCenter - safeCenter;
  })()`);
  await cdp.evaluate(`new Promise((resolve) => requestAnimationFrame(resolve))`);
  await cdp.click(finderExpr);
}

/** A failed solo Stage shows its one-line failure reason beside the goal without opening the
 * toggle; Stage A only succeeds, so only Stage D exercises this. */
export async function assertStageDFailureReason(cdp, findings, failures, stageDTitle, deps) {
  const { titleSelector, expandRow, settleForScreenshot, SHOTS_DIR } = deps;
  await cdp.waitFor(`!!${titleSelector(stageDTitle)}`, { timeoutMs: 15_000, label: 'Stage D row mounted' });
  await expandRow(cdp, stageDTitle);
  await cdp.waitFor(`(${stageContentSelector(stageDTitle)})?.textContent.includes('Probe failed: deliberately failing solo probe') ?? false`, {
    timeoutMs: 15_000,
    label: 'Stage D settles (failed)'
  });
  const stageDGoal = await cdp.evaluate(`(${goalParagraphSelector(stageDTitle)})?.textContent ?? null`);
  if (!stageDGoal?.includes('Run a probe for issue #1077 deliberately made to fail')) {
    failures.push(`Stage D's own goal paragraph is missing or wrong (got ${JSON.stringify(stageDGoal)}).`);
  } else {
    findings.push("Stage D (a failed solo Stage): its own goal paragraph still renders, exactly like a succeeding solo Stage's.");
  }
  const stageDFailureReason = await cdp.evaluate(`(() => {
    const content = (${stageContentSelector(stageDTitle)});
    if (!content) return { found: false };
    const reasonP = Array.from(content.querySelectorAll('p')).find((p) => p.textContent?.includes('Probe failed: deliberately failing solo probe for issue #1077.'));
    if (!reasonP) return { found: false };
    return { found: true, hiddenBehindToggle: !!reasonP.closest('[hidden]') };
  })()`);
  if (!stageDFailureReason.found) {
    failures.push("Stage D's own one-line failure reason does not render next to its goal (gate round 1 fix, item 6).");
  } else if (stageDFailureReason.hiddenBehindToggle) {
    failures.push('Stage D\'s own one-line failure reason is hidden behind the "See input & output" toggle -- it must be reachable WITHOUT opening it, the same as a multi-agent member\'s own one-line summary.');
  } else {
    findings.push('Stage D\'s own one-line failure reason ("Probe failed: deliberately failing solo probe for issue #1077.") renders next to its goal, reachable without opening the toggle (gate round 1 fix, item 6).');
  }
  await settleForScreenshot(cdp);
  await cdp.screenshot(path.join(SHOTS_DIR, '04-stage-d-failure-reason.png'));
}
