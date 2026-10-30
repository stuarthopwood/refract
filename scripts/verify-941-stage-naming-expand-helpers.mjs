// Click-then-assert-aria-expanded helpers shared by the `verify-941-*` scripts.
import { clickScrolled, stageTriggerSelector } from './verify-941-stage-naming-helpers.mjs';

/** Clicks only when not already expanded: `switchTheme` never reloads the app, so a later theme
 * pass would otherwise re-collapse a row an earlier pass expanded. */
export async function expandByFinder(cdp, triggerFinderExpr) {
  const isExpanded = await cdp.evaluate(`(${triggerFinderExpr})?.getAttribute('aria-expanded') === 'true'`);
  if (!isExpanded) await clickScrolled(cdp, triggerFinderExpr);
}

export async function expandRow(cdp, titleText) {
  await expandByFinder(cdp, stageTriggerSelector(titleText));
}

/** Asserts a known starting `aria-expanded` and `'true'` after expanding. Pass
 * `firstPassExpectedBefore` only on the first theme pass for rows whose starting state is
 * deterministic; later passes may start already expanded, so leave it `undefined` there. */
export async function assertExpandCycleByFinder(cdp, triggerFinderExpr, findings, failures, themeName, label, firstPassExpectedBefore) {
  const before = await cdp.evaluate(`(${triggerFinderExpr})?.getAttribute('aria-expanded') ?? null`);
  if (firstPassExpectedBefore !== undefined) {
    if (before !== firstPassExpectedBefore) {
      failures.push(`[${themeName}] ${label}'s own trigger aria-expanded was ${JSON.stringify(before)} before expanding on the FIRST theme pass, expected exactly the string ${JSON.stringify(firstPassExpectedBefore)} (this fixture's own real defaultOpen starting state).`);
    } else {
      findings.push(`[${themeName}] ${label}'s own trigger aria-expanded is exactly ${JSON.stringify(firstPassExpectedBefore)} before expanding, as expected on the first theme pass (a genuine starting-state check against this fixture's own real defaultOpen value, not merely a known boolean).`);
    }
  } else if (before !== 'true' && before !== 'false') {
    failures.push(`[${themeName}] ${label}'s own trigger aria-expanded was ${JSON.stringify(before)} before expanding, expected the string "true" or "false" (a known starting state).`);
  } else {
    findings.push(`[${themeName}] ${label}'s own trigger aria-expanded is a known starting state (${JSON.stringify(before)}) before expanding (a prior theme pass in this run may have already expanded it -- switchTheme never reloads the app).`);
  }
  await expandByFinder(cdp, triggerFinderExpr);
  const after = await cdp.evaluate(`(${triggerFinderExpr})?.getAttribute('aria-expanded') ?? null`);
  if (after !== 'true') {
    failures.push(`[${themeName}] ${label}'s own trigger aria-expanded was ${JSON.stringify(after)} after expanding, expected the string "true".`);
  } else {
    findings.push(`[${themeName}] ${label}'s own trigger aria-expanded is the string "true" after expanding.`);
  }
}
