// Overflow/clipping assertions for `StageContextBrief.tsx` (Stage 7 fold, Stage 10 narrow viewport), split out for the #806 size cap.
// The brief no longer applies `inert`; only an overflowing focusable descendant gets `tabindex="-1"` while collapsed.
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

const NARROW_WIDTH = 360;

/** Stage 7 collapse/expand/re-collapse: the heading and link below the fold must be capped, then restored. Each check is an independent `if` so none is skipped. */
export async function assertContextBriefOverflow(cdp, findings, failures, themeName, isFirstThemePass) {
  // Stage 7's frames are unpaced, so whether it was ever observably open before settling is not reproducible: accept either (#991).
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
  // The button's rendered text must read "Show less", not just have aria-expanded set.
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
    // A re-render could unmount the button and strand focus, so assert focus explicitly.
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
      // The code block's original tabindex is "0", so a blind removeAttribute('tabindex') would demote it;
      // the plain link (no original tabindex) cannot catch that regression.
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

/** Stage 10's borderline-length context fits the cap at normal width but overflows when narrowed, proving the `ResizeObserver` re-measures on layout change; the override is cleared afterwards. */
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
