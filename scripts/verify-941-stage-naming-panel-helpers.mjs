// Split from `verify-941-stage-naming-helpers.mjs` for the #806 file-size cap: Stage "Uses:"
// dependency lines and what clicking them does to the Subagent panel.
import {
  expandRow,
  assertExpandCycleByFinder,
  clickScrolled,
  clickByLabelScrolled,
  stageContentSelector,
  stageTriggerSelector,
  STAGE1_TITLE,
  STAGE2_TITLE,
  STAGE3_TITLE,
  STAGE6_SOLO_TITLE,
  STAGE7_TITLE
} from './verify-941-stage-naming-helpers.mjs';

async function assertExpandCycle(cdp, titleText, findings, failures, themeName, label, firstPassExpectedBefore) {
  await assertExpandCycleByFinder(cdp, stageTriggerSelector(titleText), findings, failures, themeName, label, firstPassExpectedBefore);
}

/** Asserts Stage "Uses:" lines (resolved, dropped self/unmatched references) and that clicking a
 * dependency button selects exactly the right Subagent panel row, including across a tab remount. */
export async function assertDependencies(cdp, findings, failures, themeName, isFirstThemePass) {
  // Stage 2's frames are unpaced, so whether it was ever observed open is not reproducible; accept either.
  await assertExpandCycle(cdp, STAGE2_TITLE, findings, failures, themeName, 'Stage 2', undefined);
  await cdp.waitFor(`${stageContentSelector(STAGE2_TITLE)}?.textContent.includes('Uses:') ?? false`, {
    timeoutMs: 10_000,
    label: `[${themeName}] Stage 2 expanded, Uses: line visible`
  }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const stage2ContentText = await cdp.evaluate(`${stageContentSelector(STAGE2_TITLE)}?.textContent ?? ''`);
  const usesLineText = stage2ContentText.includes('Uses:') ? stage2ContentText.slice(stage2ContentText.indexOf('Uses:')) : '';
  if (!usesLineText.includes('G923Code') || !usesLineText.includes('Stage 1')) {
    failures.push(`[${themeName}] Stage 2's own "Uses:" does not contain "G923Code" grouped under "(Stage 1)": ${JSON.stringify(usesLineText.slice(0, 120))}`);
  } else {
    findings.push(`[${themeName}] Stage 2's own "Uses:" line names G923Code under (Stage 1), as issue #941 requires.`);
  }
  if (usesLineText.includes('NoSuchAgent')) {
    failures.push(`[${themeName}] REGRESSION: Stage 2's own "Uses:" line contains the unmatched "agent://NoSuchAgent" reference, which should have been silently dropped.`);
  } else {
    findings.push(`[${themeName}] Stage 2's own "Uses:" line never mentions the unmatched NoSuchAgent reference.`);
  }

  for (const [label, titleText] of [
    ['Stage 1', STAGE1_TITLE],
    ['Stage 3', STAGE3_TITLE]
  ]) {
    // Radix unmounts a closed row's content, so an absent "Uses:" only proves something once expanded.
    await expandRow(cdp, titleText);
    const text = await cdp.evaluate(`${stageContentSelector(titleText)}?.textContent ?? ''`);
    if (text.includes('Uses:')) {
      failures.push(`[${themeName}] ${label} unexpectedly shows a "Uses:" line (it has no real inbound dependency): ${JSON.stringify(text.slice(0, 120))}`);
    } else {
      findings.push(`[${themeName}] ${label}, now expanded, shows no "Uses:" line, as expected (no real dependency) -- a genuine negative, not merely an unmounted row.`);
    }
  }

  // Stage 7's self-reference is dropped, so "Uses:" must not render at all.
  await expandRow(cdp, STAGE7_TITLE);
  const stage7ContentText = await cdp.evaluate(`${stageContentSelector(STAGE7_TITLE)}?.textContent ?? ''`);
  if (stage7ContentText.includes('Uses:')) {
    failures.push(`[${themeName}] REGRESSION: Stage 7 shows a "Uses:" line (${JSON.stringify(stage7ContentText.slice(stage7ContentText.indexOf('Uses:'), stage7ContentText.indexOf('Uses:') + 80))}) despite its only reference being a SELF-reference (agent://LongCtxA, one of Stage 7's own agents), which must be dropped.`);
  } else {
    findings.push(`[${themeName}] Stage 7 shows no "Uses:" line -- its own self-reference to agent://LongCtxA (one of its own agents) was correctly dropped.`);
  }

  // The real aria-label is "<id>, open in Subagents panel" (StageDependencies.tsx); clickByLabel matches exactly.
  await clickByLabelScrolled(cdp, 'G923Code, open in Subagents panel');
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: `[${themeName}] Subagent panel opened from Stage 2's Uses: button` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const selectedRowText = await cdp.evaluate(`document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]')?.textContent ?? null`);
  if (!selectedRowText || !selectedRowText.includes('G923Code')) {
    failures.push(`[${themeName}] Clicking the "Uses:" G923Code button did not select G923Code's own row in the Subagent panel (selected row text: ${JSON.stringify(selectedRowText)}).`);
  } else {
    findings.push(`[${themeName}] Clicking the real "Uses:" G923Code button opened the Subagent panel with G923Code's own row selected.`);
  }
  await clickScrolled(cdp, `document.querySelector('[data-panel-close]')`).catch(() => {});
  await cdp.waitFor(`!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: `[${themeName}] Subagent panel closed` }).catch(() => {});

  // Stage 6 (solo) resolves "Story559" to the latest earlier occurrence (Stage 5, not Stage 2).
  await expandRow(cdp, STAGE6_SOLO_TITLE);
  const stage6ContentText = await cdp.evaluate(`${stageContentSelector(STAGE6_SOLO_TITLE)}?.textContent ?? ''`);
  const stage6UsesText = stage6ContentText.includes('Uses:') ? stage6ContentText.slice(stage6ContentText.indexOf('Uses:')) : '';
  if (!stage6UsesText.includes('Story559') || !stage6UsesText.includes('Stage 5')) {
    failures.push(`[${themeName}] Stage 6 (solo)'s own "Uses:" does not contain "Story559" grouped under "(Stage 5)" (the LATEST earlier occurrence): ${JSON.stringify(stage6UsesText.slice(0, 120))}`);
  } else {
    findings.push(`[${themeName}] Stage 6 (solo)'s own "Uses:" line resolves Story559 to (Stage 5), the LATEST earlier occurrence, proving the solo path is no longer special-cased.`);
  }
  await clickByLabelScrolled(cdp, 'Story559, open in Subagents panel');
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: `[${themeName}] Subagent panel opened from Stage 6's Uses: button` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  // Exactly one row must be selected: name-based selection would mark both same-named rows.
  const assertStory559PanelSelection = async (checkLabel) => {
    const selection = await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('[role="tree"][aria-label="Subagents"] [role="treeitem"]'));
      const selected = rows.filter((el) => el.getAttribute('aria-selected') === 'true');
      return { count: selected.length, texts: selected.map((el) => el.textContent) };
    })()`);
    if (selection.count !== 1) {
      failures.push(`[${themeName}] ${checkLabel}: exactly ONE Subagent panel row should be aria-selected after clicking Stage 6's "Uses:" Story559 button, got ${selection.count} (texts: ${JSON.stringify(selection.texts)}) -- this is exactly what the OLD name-based selection would do (both same-named rows marked selected at once).`);
      return;
    }
    const [selectedText] = selection.texts;
    if (!selectedText.includes('Story559') || !selectedText.includes('4s') || selectedText.includes('2s')) {
      failures.push(`[${themeName}] ${checkLabel}: the one selected Subagent panel row does not carry Stage 5's own duration ("4s", from its 4300ms, never Stage 2's "2s") alongside "Story559" (got: ${JSON.stringify(selectedText)}).`);
    } else {
      findings.push(`[${themeName}] ${checkLabel}: exactly one Subagent panel row is selected, carrying "Story559" and Stage 5's own "4s" duration -- the LATEST occurrence (not Stage 2's "2s") resolved by toolCallId+specIndex, never name alone.`);
    }
  };
  await assertStory559PanelSelection('Initial selection');
  // Switching tabs unmounts SubagentPanel; selection must survive via the store's `selectedKey`, not local state.
  await clickByLabelScrolled(cdp, 'File explorer panel');
  await cdp.waitFor(`!!document.querySelector('[aria-label="File explorer"]')`, { timeoutMs: 10_000, label: `[${themeName}] File explorer panel opened (tab switch away)` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  await clickScrolled(cdp, `document.querySelector('#panel-tab-subagents')`);
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: `[${themeName}] Subagents tab reactivated, panel remounted` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  await assertStory559PanelSelection('After tab-switch-away-and-back remount');
  await clickScrolled(cdp, `document.querySelector('[aria-label="Close File explorer panel"]')`).catch(() => {});
  await clickScrolled(cdp, `document.querySelector('[data-panel-close]')`).catch(() => {});
  await cdp.waitFor(`!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: `[${themeName}] Subagent panel closed` }).catch(() => {});
}
