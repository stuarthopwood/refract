// Shared selector/driving helpers for `scripts/verify-1077-agent-goal.mjs` (issue #1077: agent
// rows show only the goal, Prompt/Result behind a "See input & output" toggle), split out once
// Stage D's own failure-reason phase (gate round 1 fix, item 6) pushed the main script over the
// #806 600-line file-size cap -- the same precedent `verify-941-stage-naming-helpers.mjs`'s own
// header already sets for this repo.
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

/** `clickScrolled`'s own `scrollIntoView({ block: 'center' })` clamps at `scrollTop: 0` when a
 * row sits close enough to the top of a SHORT conversation that true centring would need a
 * negative scroll -- Stage A, right after this phase's own toggle reopen grows its row tall,
 * is exactly that row. The clamp lands it a few px UNDER the chat pane's own `<header>` (always
 * the first `<header>` in document order, `ChatHeader.tsx`), which sits in normal flow ABOVE
 * the scrollable transcript, not fixed/overlaid -- `clickScrolled`'s generic helper (shared by
 * many other passing scripts, whose own fixtures never park a row this close to the top right
 * after it grows) has no reason to know about that header, so this nudges the SAME scrollable
 * viewport (`[data-slot="message-scroller-viewport"]`) by exactly the delta needed to clear it,
 * computed fresh from the live DOM rather than guessed, then clicks directly (bypassing
 * `clickScrolled`'s own `block:'center'` entirely for this one call). */
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

/** Phase 10 (gate round 1 fix, item 6's own required live step): a failed SOLO Stage's own
 * one-line failure reason shows next to its goal, reachable without opening the toggle -- Stage
 * A (the main script's other solo Stage) only ever succeeds, so it alone never exercises this
 * path. `deps` carries everything this needs from the caller rather than re-importing (keeps
 * this one function's own dependency surface explicit): `titleSelector`/`expandRow` (driving),
 * `settleForScreenshot` (pre-shot stray-tooltip guard), `SHOTS_DIR` (screenshot destination). */
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
