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
  clickScrolled,
  stageContentSelector,
  stageTriggerSelector,
  STAGE7_TITLE,
  STAGE10_BORDERLINE_TITLE
} from './verify-941-stage-naming-helpers.mjs';

async function assertExpandCycle(cdp, titleText, findings, failures, themeName, label, firstPassExpectedBefore) {
  await assertExpandCycleByFinder(cdp, stageTriggerSelector(titleText), findings, failures, themeName, label, firstPassExpectedBefore);
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
export async function assertContextBriefOverflow(cdp, findings, failures, themeName, isFirstThemePass) {
  // Issue #991 final-delta fix: Stage 7's own frames are unpaced (no fixture delay), so whether
  // it was ever observably open before settling is not reliably reproducible -- accept either
  // known boolean (see `assertExpandCycleByFinder`'s own doc comment for the full rationale).
  await assertExpandCycle(cdp, STAGE7_TITLE, findings, failures, themeName, 'Stage 7', undefined);
  const briefButtonFinder = `Array.from((${stageContentSelector(STAGE7_TITLE)})?.querySelectorAll('button') ?? []).find((b) => /Show full brief|Show less/.test(b.textContent.trim()))`;
  const measure = () => cdp.evaluate(`(() => {
    const btn = ${briefButtonFinder};
    if (!btn) return null;
    const contentId = btn.getAttribute('aria-controls');
    const container = contentId ? document.getElementById(contentId) : null;
    if (!container) return null;
    const heading = container.querySelector('h1,h2,h3,h4,h5,h6');
    const link = container.querySelector('a[href]');
    // Gate round 4 fix (issue #941, item 12, MEDIUM): a fenced code block (Markdown.tsx's own
    // \`CodeBlock\`, always \`tabIndex=0\` on its content region, \`role="region"\`) is a SEPARATE
    // kind of pre-existing focusable descendant from the plain link above -- the gate-round-3
    // fix's own comment specifically calls out restoring "a scrollable code block's own
    // tabIndex=0" without blindly clobbering it to null, which no fixture element exercised
    // before this (the old selector's own \`[tabindex]\` branch could silently match either).
    const code = container.querySelector('pre[role="region"], div[role="region"]');
    return {
      buttonText: btn.textContent.trim(),
      ariaExpanded: btn.getAttribute('aria-expanded'),
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      headingOffsetTop: heading ? heading.offsetTop : null,
      headingTag: heading ? heading.tagName : null,
      hasLink: !!link,
      linkTabIndexAttr: link ? link.getAttribute('tabindex') : null,
      hasCode: !!code,
      codeTabIndexAttr: code ? code.getAttribute('tabindex') : null,
      focusIsOnButton: document.activeElement === btn
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
  // Gate round 4 fix (issue #941, item 12, MEDIUM): the button's own text was captured by
  // `measure()` but never actually asserted anywhere below -- only `aria-expanded` was. "Show
  // less" (item 12's own wording) must genuinely exist as the button's real rendered text once
  // expanded, not merely inferred from the ARIA state.
  if (!collapsed.buttonText.startsWith('Show full brief (')) {
    failures.push(`[${themeName}] Stage 7's toggle button reads ${JSON.stringify(collapsed.buttonText)} while collapsed, expected it to start with "Show full brief (".`);
  } else {
    findings.push(`[${themeName}] Stage 7's toggle button reads ${JSON.stringify(collapsed.buttonText)} while collapsed.`);
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
  if (!collapsed.hasCode) {
    failures.push(`[${themeName}] Stage 7's own context brief has no fenced code block descendant near its end to prove the tabindex-RESTORE behaviour (distinct from a plain link, item 12) -- fixture expectation not met.`);
  } else if (collapsed.codeTabIndexAttr !== '-1') {
    failures.push(`[${themeName}] Stage 7's own overflowing code-block region has tabindex=${JSON.stringify(collapsed.codeTabIndexAttr)} while collapsed, expected "-1".`);
  } else {
    findings.push(`[${themeName}] Stage 7's own overflowing code-block region carries tabindex="-1" while collapsed, out of the Tab order.`);
  }

  await clickScrolled(cdp, briefButtonFinder);
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
    if (expanded.buttonText !== 'Show less') {
      failures.push(`[${themeName}] Stage 7's toggle button reads ${JSON.stringify(expanded.buttonText)} after expanding, expected exactly "Show less".`);
    } else {
      findings.push(`[${themeName}] Stage 7's toggle button reads exactly "Show less" after expanding.`);
    }
    // Gate round 4 fix (issue #941, item 12, MEDIUM): the click's own event target is this
    // button, but React re-rendering its CHILDREN (the label text, the grown container) could
    // still strand focus elsewhere if any of that re-render ever unmounted the button itself --
    // asserted explicitly rather than assumed.
    if (!expanded.focusIsOnButton) {
      failures.push(`[${themeName}] Focus is no longer on Stage 7's own toggle button after expanding it (it should stay there -- the button itself never unmounts, only its label text and the container's height change).`);
    } else {
      findings.push(`[${themeName}] Focus stays on Stage 7's own toggle button after expanding it.`);
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
    if (!expanded.hasCode) {
      failures.push(`[${themeName}] Stage 7's own code-block region disappeared after expanding (expected it still present).`);
    } else if (expanded.codeTabIndexAttr !== '0') {
      // Gate round 3 fix (item 2)'s own exact regression this guards: a code block's own
      // ORIGINAL tabindex is "0" (Markdown.tsx's own `tabIndex={0}`), never "no attribute at
      // all" -- a blind `removeAttribute('tabindex')` (the pre-gate-round-3 bug) would restore
      // it to NO tabindex rather than its own true original value, silently demoting it from an
      // explicit Tab stop to one that merely inherits default element focusability (or none, for
      // a `<div>`). The ONLY fixture element that can prove this restores the ORIGINAL value
      // (not merely "removed") rather than "any non -1 value" is one whose own original
      // tabindex was never null to begin with -- the plain `<a href>` link above has no
      // original tabindex attribute at all, so its own restore-to-null assertion cannot catch
      // this; the code block can.
      failures.push(`[${themeName}] Stage 7's own code-block region has tabindex=${JSON.stringify(expanded.codeTabIndexAttr)} after expanding, expected its own ORIGINAL value "0" restored (never a blind \`removeAttribute\`, which would leave no tabindex attribute at all).`);
    } else {
      findings.push(`[${themeName}] Stage 7's own code-block region has its ORIGINAL tabindex="0" restored after expanding (not merely removed), now within the grown container's visible area.`);
    }
  }

  await clickScrolled(cdp, briefButtonFinder);
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
    if (!reCollapsed.buttonText.startsWith('Show full brief (')) {
      failures.push(`[${themeName}] Stage 7's toggle button reads ${JSON.stringify(reCollapsed.buttonText)} after re-collapsing, expected it to start with "Show full brief (" again.`);
    } else {
      findings.push(`[${themeName}] Stage 7's toggle button reads ${JSON.stringify(reCollapsed.buttonText)} after re-collapsing.`);
    }
    if (!reCollapsed.focusIsOnButton) {
      failures.push(`[${themeName}] Focus is no longer on Stage 7's own toggle button after re-collapsing it with "Show less" (it should stay there).`);
    } else {
      findings.push(`[${themeName}] Focus stays on Stage 7's own toggle button after clicking "Show less" to re-collapse it.`);
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
    if (!reCollapsed.hasCode || reCollapsed.codeTabIndexAttr !== '-1') {
      failures.push(`[${themeName}] Stage 7's own code-block region did not regain tabindex="-1" after re-collapsing (hasCode ${reCollapsed.hasCode}, tabindex ${JSON.stringify(reCollapsed.codeTabIndexAttr)}).`);
    } else {
      findings.push(`[${themeName}] Stage 7's own code-block region regains tabindex="-1" after re-collapsing, pulled back out of the Tab order.`);
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
