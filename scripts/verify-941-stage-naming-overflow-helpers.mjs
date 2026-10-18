// Split out of `verify-941-stage-naming-helpers.mjs` (gate round 2, #806 file-size discipline:
// the main helpers file grew past the 600-line cap once items 9-12 landed). Both of this file's
// assertions concern `StageContextBrief.tsx`'s own overflow/clipping and `ResizeObserver`
// behaviour specifically (Stage 7's collapsed/expanded fold, Stage 10's narrow-viewport
// overflow) -- a cohesive slice distinct from naming/dependencies/chain-row, so it is its own
// module rather than an arbitrary line-count split. Re-grep-verified against
// `StageContextBrief.tsx` in full (gate round 2, item 10): it no longer applies `inert` to its
// own container -- only an overflowing FOCUSABLE descendant gets `tabindex="-1"` while
// collapsed, restored on expand/no-longer-overflowing.
import {
  expandRow,
  assertExpandCycleByFinder,
  stageContentSelector,
  stageTriggerSelector,
  STAGE7_TITLE,
  STAGE10_BORDERLINE_TITLE
} from './verify-941-stage-naming-helpers.mjs';

async function assertExpandCycle(cdp, titleText, findings, failures, themeName, label) {
  await assertExpandCycleByFinder(cdp, stageTriggerSelector(titleText), findings, failures, themeName, label);
}

// Gate round 2 fix (item 12): the narrow-viewport width, same value `verify-557-thought-runs.mjs`/
// `verify-558-blocker-callout.mjs`/`verify-565-spine.mjs` already use for their own no-horizontal-
// scroll checks (grep-verified precedent, not invented here).
const NARROW_WIDTH = 360;

/** Fixture item d / issue #941 grill item 4, gate round 2 rewrite (item 10): `StageContextBrief.
 * tsx` (re-read in full) no longer applies `inert` to its own container -- a screen reader must
 * read the full brief regardless of collapse state; only a focusable descendant whose own top
 * edge sits past the fold gets `tabindex="-1"` while collapsed, restored on expand. Stage 7's
 * context now places both its Markdown heading AND a focusable link near the END (several plain
 * bullet points first), so this asserts (collapsed): the brief is visually capped, a REAL
 * rendered heading element exists below the fold, and the link descendant carries
 * `tabindex="-1"`; then (expanded): the heading is within the grown container and the link's
 * `tabindex` attribute is removed (restored to the Tab order); then (re-collapsed): both revert.
 * Every check below is an INDEPENDENT `if` (gate round 2 fix, item 10) -- never an `if`/`else
 * if` chain that would silently skip a later assertion once an earlier one matches. */
export async function assertContextBriefOverflow(cdp, findings, failures, themeName) {
  await assertExpandCycle(cdp, STAGE7_TITLE, findings, failures, themeName, 'Stage 7');
  const briefButtonFinder = `Array.from((${stageContentSelector(STAGE7_TITLE)})?.querySelectorAll('button') ?? []).find((b) => /Show full brief|Show less/.test(b.textContent.trim()))`;
  await cdp.waitFor(`!!(${briefButtonFinder})`, { timeoutMs: 10_000, label: `[${themeName}] Stage 7's "Show full brief" toggle rendered` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const measure = () => cdp.evaluate(`(() => {
    const btn = ${briefButtonFinder};
    if (!btn) return null;
    const contentId = btn.getAttribute('aria-controls');
    const container = contentId ? document.getElementById(contentId) : null;
    if (!container) return null;
    const heading = container.querySelector('h1,h2,h3,h4,h5,h6');
    const link = container.querySelector('a[href], button, [tabindex]');
    return {
      buttonText: btn.textContent.trim(),
      ariaExpanded: btn.getAttribute('aria-expanded'),
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      headingOffsetTop: heading ? heading.offsetTop : null,
      headingTag: heading ? heading.tagName : null,
      hasLink: !!link,
      linkTabIndexAttr: link ? link.getAttribute('tabindex') : null
    };
  })()`);

  const collapsed = await measure();
  if (!collapsed) {
    failures.push(`[${themeName}] Could not measure Stage 7's own context brief (toggle/container not found).`);
    return;
  }
  if (collapsed.ariaExpanded !== 'false') {
    failures.push(`[${themeName}] Stage 7's "Show full brief" button aria-expanded was ${JSON.stringify(collapsed.ariaExpanded)} while collapsed, expected the string "false".`);
  } else {
    findings.push(`[${themeName}] Stage 7's "Show full brief" button aria-expanded is the string "false" while collapsed.`);
  }
  if (collapsed.clientHeight >= collapsed.scrollHeight) {
    failures.push(`[${themeName}] Stage 7's own context brief is not actually capped (clientHeight ${collapsed.clientHeight} >= scrollHeight ${collapsed.scrollHeight}) -- the overflow this test depends on never happened.`);
  } else {
    findings.push(`[${themeName}] Stage 7's own context brief is visually capped (clientHeight ${collapsed.clientHeight} < scrollHeight ${collapsed.scrollHeight}).`);
  }
  if (collapsed.headingOffsetTop === null) {
    failures.push(`[${themeName}] Stage 7's own rendered Markdown heading ("## Key considerations") was not found inside its context brief (expected a REAL <h1>-<h6> element, not just new text appearing).`);
  } else if (collapsed.headingOffsetTop < collapsed.clientHeight) {
    failures.push(`[${themeName}] Stage 7's own Markdown heading (<${collapsed.headingTag}>) is already within the visible, collapsed fold (offsetTop ${collapsed.headingOffsetTop} < clientHeight ${collapsed.clientHeight}) -- placed near the end of the brief, it should be clipped away until expanded.`);
  } else {
    findings.push(`[${themeName}] Stage 7's own rendered <${collapsed.headingTag}> heading sits below the visible, collapsed fold (offsetTop ${collapsed.headingOffsetTop} >= clientHeight ${collapsed.clientHeight}).`);
  }
  if (!collapsed.hasLink) {
    failures.push(`[${themeName}] Stage 7's own context brief has no focusable link descendant near its end to prove the tabindex-withholding behaviour -- fixture expectation not met.`);
  } else if (collapsed.linkTabIndexAttr !== '-1') {
    failures.push(`[${themeName}] Stage 7's own overflowing link descendant has tabindex=${JSON.stringify(collapsed.linkTabIndexAttr)} while collapsed, expected "-1" (StageContextBrief.tsx pulls an overflowing focusable descendant out of the Tab order while collapsed; it never applies 'inert' to the whole container).`);
  } else {
    findings.push(`[${themeName}] Stage 7's own overflowing link descendant carries tabindex="-1" while collapsed, out of the Tab order -- the visible text itself stays fully readable by a screen reader regardless.`);
  }

  await cdp.click(briefButtonFinder);
  await cdp.waitFor(`(${briefButtonFinder})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: `[${themeName}] Stage 7's "Show full brief" expanded` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const expanded = await measure();
  if (!expanded) {
    failures.push(`[${themeName}] Could not re-measure Stage 7's own context brief after expanding.`);
  } else {
    if (expanded.ariaExpanded !== 'true') {
      failures.push(`[${themeName}] Stage 7's "Show full brief" button aria-expanded was ${JSON.stringify(expanded.ariaExpanded)} after clicking it, expected the string "true".`);
    } else {
      findings.push(`[${themeName}] Stage 7's "Show full brief" button aria-expanded is the string "true" after expanding.`);
    }
    if (expanded.headingOffsetTop === null || expanded.headingOffsetTop >= expanded.clientHeight) {
      failures.push(`[${themeName}] Stage 7's own Markdown heading is still clipped (offsetTop ${expanded.headingOffsetTop}, clientHeight ${expanded.clientHeight}) after expanding -- it should now be fully within the visible, grown container.`);
    } else {
      findings.push(`[${themeName}] Expanding Stage 7's "Show full brief" reveals its own <${expanded.headingTag}> heading in full (offsetTop ${expanded.headingOffsetTop} < grown clientHeight ${expanded.clientHeight}).`);
    }
    if (!expanded.hasLink) {
      failures.push(`[${themeName}] Stage 7's own link descendant disappeared after expanding (expected it still present, just restored to the Tab order).`);
    } else if (expanded.linkTabIndexAttr !== null) {
      failures.push(`[${themeName}] Stage 7's own link descendant still carries tabindex=${JSON.stringify(expanded.linkTabIndexAttr)} after expanding, expected the attribute removed (restored to the Tab order).`);
    } else {
      findings.push(`[${themeName}] Stage 7's own link descendant has its tabindex attribute removed after expanding, restored to the Tab order, now within the grown container's visible area.`);
    }
  }

  await cdp.click(briefButtonFinder);
  await cdp.waitFor(`(${briefButtonFinder})?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: `[${themeName}] Stage 7's "Show less" re-collapsed` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const reCollapsed = await measure();
  if (!reCollapsed) {
    failures.push(`[${themeName}] Could not re-measure Stage 7's own context brief after re-collapsing.`);
  } else {
    if (reCollapsed.ariaExpanded !== 'false') {
      failures.push(`[${themeName}] Stage 7's "Show less" button aria-expanded was ${JSON.stringify(reCollapsed.ariaExpanded)} after clicking it, expected the string "false".`);
    } else {
      findings.push(`[${themeName}] Stage 7's "Show less" button aria-expanded is the string "false" after re-collapsing.`);
    }
    if (reCollapsed.headingOffsetTop === null || reCollapsed.headingOffsetTop < reCollapsed.clientHeight) {
      failures.push(`[${themeName}] Stage 7's own heading did not re-clip correctly after "Show less" (offsetTop ${reCollapsed.headingOffsetTop}, clientHeight ${reCollapsed.clientHeight}).`);
    } else {
      findings.push(`[${themeName}] Clicking "Show less" re-collapses Stage 7's own context brief: its heading is clipped away again (offsetTop ${reCollapsed.headingOffsetTop} >= clientHeight ${reCollapsed.clientHeight}).`);
    }
    if (!reCollapsed.hasLink || reCollapsed.linkTabIndexAttr !== '-1') {
      failures.push(`[${themeName}] Stage 7's own link descendant did not regain tabindex="-1" after re-collapsing (hasLink ${reCollapsed.hasLink}, tabindex ${JSON.stringify(reCollapsed.linkTabIndexAttr)}).`);
    } else {
      findings.push(`[${themeName}] Stage 7's own link descendant regains tabindex="-1" after re-collapsing, pulled back out of the Tab order.`);
    }
  }
}

/** Gate round 2 fix (item 12, second check): Stage 10's own context is borderline-length --
 * chosen to fit the ~6-line/144px cap at a normal composer width but overflow it once the
 * window narrows, proving `StageContextBrief.tsx`'s own `ResizeObserver` genuinely re-measures
 * on a real layout change, not just once at component mount. Narrows via the same
 * `Emulation.setDeviceMetricsOverride` precedent `verify-tauri-569.mjs`/
 * `verify-557-thought-runs.mjs`/`verify-565-spine.mjs` already establish for this app (grep-
 * verified, not invented here), restoring via `Emulation.clearDeviceMetricsOverride` afterward
 * so later screenshots/assertions in this same theme pass are unaffected. */
export async function assertNarrowViewportOverflow(cdp, findings, failures, themeName) {
  await expandRow(cdp, STAGE10_BORDERLINE_TITLE);
  const briefButtonFinder = `Array.from((${stageContentSelector(STAGE10_BORDERLINE_TITLE)})?.querySelectorAll('button') ?? []).find((b) => /Show full brief|Show less/.test(b.textContent.trim()))`;
  const normalToggle = await cdp.evaluate(`!!(${briefButtonFinder})`);
  if (normalToggle) {
    failures.push(`[${themeName}] Stage 10's own context brief already shows the "Show full brief" toggle at normal width -- it must NOT overflow before narrowing (fixture's borderline length is miscalibrated for this run).`);
  } else {
    findings.push(`[${themeName}] Stage 10's own context brief does not overflow at normal width (no "Show full brief" toggle present), as this check requires.`);
  }
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: NARROW_WIDTH, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp
      .waitFor(`!!(${briefButtonFinder})`, { timeoutMs: 10_000, label: `[${themeName}] Stage 10's "Show full brief" toggle appears once narrowed to ${NARROW_WIDTH}px` })
      .then(() =>
        findings.push(
          `[${themeName}] Narrowing the window to ${NARROW_WIDTH}px makes Stage 10's own context brief overflow, and its "Show full brief" toggle appears -- proving the ResizeObserver genuinely re-measures on a real layout change, not just once at mount.`
        )
      )
      .catch((err) => failures.push(`[${themeName}] ${err.message}`));
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
  }
}
