// Split out of `verify-941-stage-naming-helpers.mjs` (issue #991 final-delta gate, #806
// file-size discipline: the main helpers file grew past the 600-line cap again once the
// upward-only-disclosure doc fix landed). The generic click-then-assert-aria-expanded trio used
// by every `verify-941-*` script's own expand-cycle checks -- a cohesive slice distinct from
// naming/dependencies/chain-row/overflow, same precedent the panel-helpers/overflow-helpers
// splits already set.
import { clickScrolled, stageTriggerSelector } from './verify-941-stage-naming-helpers.mjs';

/** Gate round 2 fix (item 9): generalized over any trigger-finding JS expression (a Stage's own
 * title-keyed trigger, or the chain row's own `aria-label`-keyed trigger) -- reads the REAL
 * current `aria-expanded` value and only clicks when it is not already `'true'`. Driving the
 * SAME scenario across three themes in one script run never re-collapses a row a PRIOR theme's
 * own pass already expanded: `switchTheme` (grep-verified) only flips a live class and never
 * reloads the app or resets React state, so without this guard a later pass would immediately
 * re-collapse a row the first pass already expanded. */
export async function expandByFinder(cdp, triggerFinderExpr) {
  const isExpanded = await cdp.evaluate(`(${triggerFinderExpr})?.getAttribute('aria-expanded') === 'true'`);
  if (!isExpanded) await clickScrolled(cdp, triggerFinderExpr);
}

export async function expandRow(cdp, titleText) {
  await expandByFinder(cdp, stageTriggerSelector(titleText));
}

/** Gate round 2 fix (item 9): asserts a trigger's own `aria-expanded` is a KNOWN boolean string
 * (`'true'` or `'false'`) before expanding -- never specifically `'false'`, since a prior theme
 * pass in the SAME run may have already expanded this exact row (see the module header) -- and
 * is exactly `'true'` after. Generalized over any trigger-finding JS expression so the chain
 * row's own expand click gets the identical guard (previously it had none at all).
 *
 * Gate round 3 fix (item 11): `firstPassExpectedBefore` (when given) asserts the row's own REAL
 * starting value exactly, instead of merely "a known boolean" -- a caller passes it only when
 * the theme pass currently running is the FIRST one for this scenario run (nothing has expanded
 * or collapsed any row yet) and the fixture's own data makes that starting value unambiguous.
 * Issue #991 final-delta fix (test-reviewer): `'false'` no longer applies to any Stage -- the
 * disclosure is upward-only (research.md decision 19), so an observed-running Stage STAYS open
 * forever after. Stage 1's own additive `{"__delay__": 1500}` makes it deterministically
 * observed running, so `'true'`. Gate round 1 fix (issue #1000, item 9): Stage 2 is NO LONGER
 * "no delay" either -- it gained its own additive `{"__delay__": 1500}` (issue #1000), and
 * under FR-087's multi-Stage defer rule it is now deterministically CLOSED while running
 * (`'false'`), not open -- but its own call site (`assertDependencies`,
 * `verify-941-stage-naming-panel-helpers.mjs`) still conservatively passes `undefined` here,
 * unchanged by this fix. Stage 7 alone remains genuinely unpaced (inside the renderer's own
 * 50ms patch-batching window), so whether it was ever observably open first is still not
 * reliably reproducible -- it stays `undefined`. The chain row keeps its own `'true'` (Stage
 * 5's `failed` agent keeps it permanently unsettled, so its own upward-only open state is
 * equally deterministic). Left `undefined` on every later pass, and for any row this fixture
 * cannot make an unambiguous claim about -- the old "a known boolean, either value" check then
 * runs unchanged. */
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
