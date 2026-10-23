// Split out of `verify-941-stage-naming-helpers.mjs` (gate round 4, #806 file-size discipline:
// the main helpers file grew past the 600-line cap once items 8/9 and the P1 tab-switch-remount
// check landed). This file's one assertion concerns a Stage's own "Uses:" dependency line and
// what clicking it does to the Subagent panel (real-agent selection, exactly-one-selected
// disambiguation, and selection surviving a tab-switch remount) -- a cohesive slice distinct
// from naming/metadata/chain-row/context-brief-overflow, matching the same precedent
// `verify-941-stage-naming-overflow-helpers.mjs` already set (gate round 2) rather than an
// arbitrary line-count split.
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

/** Issue #941 grill item 5: Stage 2's real "Uses: G923Code (Stage 1)" dependency, the dropped
 * unmatched `agent://NoSuchAgent` reference, Stage 1/Stage 3's own absence of any "Uses:" line
 * (gate round 2 fix, item 11c: both are now EXPANDED first -- `CollapsedLine.tsx`'s own comment
 * confirms Radix unmounts `CollapsibleContent` while closed, so checking an unexpanded row's
 * content for an absent "Uses:" line was a guaranteed-trivial pass, never a real negative),
 * Stage 7's own SELF-reference drop, Stage 6 (solo)'s real "Uses:" resolving the repeated name
 * "Story559" to the LATEST earlier Stage (Stage 5, by its own distinct duration "4s"), and
 * clicking the real `G923Code`/`Story559` buttons to open the Subagent panel with that agent
 * selected (`aria-selected`, re-grep-verified against `SubagentPanel.tsx`, unchanged from gate
 * round 1 -- see this file's own header for why duration remains the only available
 * disambiguator for a repeated name's two panel rows). */
export async function assertDependencies(cdp, findings, failures, themeName, isFirstThemePass) {
  // Issue #991 final-delta fix: Stage 2's own frames are unpaced (no fixture delay), so whether
  // it was ever observably open before settling is not reliably reproducible -- accept either
  // known boolean (see `assertExpandCycleByFinder`'s own doc comment for the full rationale).
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
    // Gate round 2 fix (item 11c): expand first -- a collapsed row's own `CollapsibleContent`
    // is unmounted (not merely `hidden`), so without this an absent "Uses:" line proves nothing.
    await expandRow(cdp, titleText);
    const text = await cdp.evaluate(`${stageContentSelector(titleText)}?.textContent ?? ''`);
    if (text.includes('Uses:')) {
      failures.push(`[${themeName}] ${label} unexpectedly shows a "Uses:" line (it has no real inbound dependency): ${JSON.stringify(text.slice(0, 120))}`);
    } else {
      findings.push(`[${themeName}] ${label}, now expanded, shows no "Uses:" line, as expected (no real dependency) -- a genuine negative, not merely an unmounted row.`);
    }
  }

  // Fixture item e: Stage 7's own self-reference (agent://LongCtxA, one of its OWN agents) is
  // dropped -- no other, non-self dependency exists there, so "Uses:" must not render at all.
  await expandRow(cdp, STAGE7_TITLE);
  const stage7ContentText = await cdp.evaluate(`${stageContentSelector(STAGE7_TITLE)}?.textContent ?? ''`);
  if (stage7ContentText.includes('Uses:')) {
    failures.push(`[${themeName}] REGRESSION: Stage 7 shows a "Uses:" line (${JSON.stringify(stage7ContentText.slice(stage7ContentText.indexOf('Uses:'), stage7ContentText.indexOf('Uses:') + 80))}) despite its only reference being a SELF-reference (agent://LongCtxA, one of Stage 7's own agents), which must be dropped.`);
  } else {
    findings.push(`[${themeName}] Stage 7 shows no "Uses:" line -- its own self-reference to agent://LongCtxA (one of its own agents) was correctly dropped.`);
  }

  // Clicking the real G923Code button opens the Subagent panel with that agent selected.
  // Gate round 4 fix (issue #941, item 8, HIGH): the real rendered `aria-label` is
  // `"<id>, open in Subagents panel"` (`StageDependencies.tsx`'s own `aria-label={\`${dep.agentId}, open in Subagents panel\`}\`),
  // id FIRST, lowercase "open" -- this call used the wrong, never-matching
  // "Open <id> in Subagents panel" text, so `clickByLabel`'s own default EXACT match
  // (`verify-tauri-cdp.mjs`) found nothing and the click silently no-opped.
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

  // Fixture items f/g: Stage 6 (solo) depends on "Story559", resolved to Stage 5 (the LATEST
  // earlier occurrence, not Stage 2's) -- a real "Uses:" line on a SOLO Stage, proving it is no
  // longer special-cased.
  await expandRow(cdp, STAGE6_SOLO_TITLE);
  const stage6ContentText = await cdp.evaluate(`${stageContentSelector(STAGE6_SOLO_TITLE)}?.textContent ?? ''`);
  const stage6UsesText = stage6ContentText.includes('Uses:') ? stage6ContentText.slice(stage6ContentText.indexOf('Uses:')) : '';
  if (!stage6UsesText.includes('Story559') || !stage6UsesText.includes('Stage 5')) {
    failures.push(`[${themeName}] Stage 6 (solo)'s own "Uses:" does not contain "Story559" grouped under "(Stage 5)" (the LATEST earlier occurrence): ${JSON.stringify(stage6UsesText.slice(0, 120))}`);
  } else {
    findings.push(`[${themeName}] Stage 6 (solo)'s own "Uses:" line resolves Story559 to (Stage 5), the LATEST earlier occurrence, proving the solo path is no longer special-cased.`);
  }
  // Gate round 4 fix (issue #941, item 8, HIGH): same real-label fix as G923Code above.
  await clickByLabelScrolled(cdp, 'Story559, open in Subagents panel');
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: `[${themeName}] Subagent panel opened from Stage 6's Uses: button` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  // Gate round 4 fix (issue #941, item 9, HIGH): checks exactly ONE row in the whole panel is
  // selected (not merely "some Story559 row carries 4s", which would silently pass even if
  // the OLD name-based bug marked BOTH same-named rows selected at once, so long as one of
  // them happened to include "4s") -- a real regression guard that FAILS the old behaviour:
  // the pre-#941-gate-round-3 `row.node.id === selectedId` selection marks every row sharing
  // a name simultaneously, which this assertion catches as `selectedCount !== 1`.
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
  // Gate round 4 fix (issue #941, P1, HIGH): switches the right pane's own ACTIVE tab away to
  // File explorer (a second open panel, so a real tab bar exists, `RightPaneShell.tsx` --
  // `isTabBar = openPanelIds.length >= 2`) and back, which genuinely UNMOUNTS and remounts
  // `SubagentPanel` (`activePanelId === 'subagents' && (...)`, not merely a CSS-hidden tab) --
  // proving the selection survives a real remount via the STORE's own `selectedKey`
  // (`subagent-store.ts`), not a component-local `useState` that a remount would have reset.
  await clickByLabelScrolled(cdp, 'File explorer panel');
  await cdp.waitFor(`!!document.querySelector('[aria-label="File explorer"]')`, { timeoutMs: 10_000, label: `[${themeName}] File explorer panel opened (tab switch away)` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  await clickScrolled(cdp, `document.querySelector('#panel-tab-subagents')`);
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: `[${themeName}] Subagents tab reactivated, panel remounted` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  await assertStory559PanelSelection('After tab-switch-away-and-back remount');
  await clickScrolled(cdp, `document.querySelector('[aria-label="Close File explorer panel"]')`).catch(() => {});
  await clickScrolled(cdp, `document.querySelector('[data-panel-close]')`).catch(() => {});
  await cdp.waitFor(`!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: `[${themeName}] Subagent panel closed` }).catch(() => {});
}
