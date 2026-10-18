// Shared driving/assertion helpers for `scripts/verify-941-stage-naming.mjs` (issue #941: Stage
// naming, the one green exception for a finished Subagent/Stage, the Stage's own batch context
// on expansion, real "Uses:" dependencies, the per-turn Subagent chain row, and the solo-Stage
// regression guard), split out to stay under the #806 600-line file-size cap.
//
// WRITTEN, NOT RUN: no build slot has been granted for this sub-task -- `node --check` is the
// only command that has actually been run against this file. Every DOM/class-name selector below
// was grep-verified against the real source it claims to match (`CollapsedLine.tsx`,
// `SubagentChainRow.tsx`, `StageDependencies.tsx`, `ToolRow.tsx`, `subagentStatus.tsx`,
// `collapsible.tsx`) -- see the main script's own header comment for exactly which read grounded
// which selector.
//
// Selector strategy: `CollapsedLine.tsx` sets a plain `title` attribute on a Stage/member row's
// own visible label SPAN whenever that label is a literal string (`title={typeof label ===
// 'string' ? label : undefined}`, line ~132) -- a real, source-grounded way to find one exact
// row without guessing at the FULL accessible name, which is a DIFFERENT, longer string on a
// multi-agent Stage (`triggerAriaLabel`, e.g. "Stage 1 of 4, Quality gate for #923, 2 agents, 1s"
// -- the stage COUNT and settle summary, never present in the plain visible label). The Naming
// assertion below reads the label SPAN's own accessible name via `Accessibility.getPartialAXTree`
// (never `.textContent`, the harness's own groundedness rule) -- that span carries no `aria-label`
// override of its own (only its ANCESTOR button does), so its AX name is still computed from its
// own content, giving back exactly the visible label text, through AX, not through `textContent`.

import { mkdirSync, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchViaJobObject } from './verify-tauri-cdp.mjs';
import { getAccessibleNameAndRole, resolveCssVarColor } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

/** Builds the recorded-frame fake `omp` PATH shim (`scripts/verify-tauri-omp-shim.rs`), the same
 * one `verify-563-subagent-stage.mjs` already builds for this exact purpose. */
export function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** `verify-tauri-scratch-helpers.mjs`'s own shared `launchBuiltExe` has no `pathPrepend`/
 * `extraEnv` parameters (every OTHER `verify-9xx-*.mjs` live check drives a REAL `omp`, never the
 * fake-frame harness) -- this is `verify-563-subagent-stage.mjs`'s own local copy with those two
 * params restored, needed here to put the fake-omp PATH shim first on `PATH` and set
 * `REFRACT_FAKE_OMP_SCENARIO`/`REFRACT_FAKE_OMP_SCRIPT`/`REFRACT_FAKE_OMP_NODE`. */
export async function launchBuiltExeWithEnv(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), 'target.pid');
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

// The four Stages' own visible labels (`CollapsedLine`'s `label` prop, a plain string on every
// one of these rows, so each gets a real `title` attribute to select on -- grep-verified against
// `CollapsedLine.tsx:132`). Stage 3 has no `context` at all in the fixture, so its label is the
// `sharedNamePrefix` fallback ("R8"); Stage 4 is solo, so its label is the bare agent name, never
// prefixed "Stage 4" (grep-verified against `SubagentChainRow.tsx`'s own `solo` branch, which
// passes `label={item.name}` with no "Stage N" text anywhere in it).
export const STAGE1_TITLE = 'Stage 1 \u00b7 Quality gate for #923';
export const STAGE2_TITLE = 'Stage 2 \u00b7 Build the fix for #559 and #560.';
export const STAGE3_TITLE = 'Stage 3 \u00b7 R8';
export const STAGE4_SOLO_TITLE = 'R8Solo';

function titleSelector(titleText) {
  return `document.querySelector('[title=${JSON.stringify(titleText)}]')`;
}

/** Clicks a Stage/member row's own trigger via its `title`-bearing label span (click bubbles to
 * the ancestor `CollapsibleTrigger` button, same as `verify-563`'s own
 * `textContent.includes('Stage 1')` button-finder click). */
export async function expandRow(cdp, titleText) {
  await cdp.click(titleSelector(titleText));
}

/** Issue #941 grill item 3 (Naming): the visible label's own accessible name, read via
 * `Accessibility.getPartialAXTree` on the label SPAN itself (never `.textContent`) -- the span
 * carries no `aria-label` override of its own, only its ancestor trigger button does
 * (`CollapsedLine.tsx`'s `triggerAriaLabel` prop lands on the `CollapsibleTrigger`, a DIFFERENT
 * node), so this reads back exactly the rendered label text through the accessibility tree. */
export async function assertStageNaming(cdp, findings, failures, themeName) {
  const { name: stage1Name } = await getAccessibleNameAndRole(cdp, titleSelector(STAGE1_TITLE));
  if (stage1Name !== STAGE1_TITLE) {
    failures.push(`[${themeName}] Stage 1's own visible label (AX name of its label span) was ${JSON.stringify(stage1Name)}, expected exactly ${JSON.stringify(STAGE1_TITLE)} (heading-only "# Goal" line skipped, second line used).`);
  } else {
    findings.push(`[${themeName}] Stage 1 label exactly ${JSON.stringify(STAGE1_TITLE)} (bare-heading-skip rule confirmed).`);
  }

  const { name: stage2Name } = await getAccessibleNameAndRole(cdp, titleSelector(STAGE2_TITLE));
  if (stage2Name !== STAGE2_TITLE) {
    failures.push(`[${themeName}] Stage 2's own visible label was ${JSON.stringify(stage2Name)}, expected exactly ${JSON.stringify(STAGE2_TITLE)} (plain first-line path, no heading this time).`);
  } else {
    findings.push(`[${themeName}] Stage 2 label exactly ${JSON.stringify(STAGE2_TITLE)} (plain first-line rule confirmed).`);
  }

  const { name: stage3Name } = await getAccessibleNameAndRole(cdp, titleSelector(STAGE3_TITLE));
  if (stage3Name !== STAGE3_TITLE) {
    failures.push(`[${themeName}] Stage 3's own visible label was ${JSON.stringify(stage3Name)}, expected exactly ${JSON.stringify(STAGE3_TITLE)} (no context at all -- shared-name-prefix fallback "R8").`);
  } else {
    findings.push(`[${themeName}] Stage 3 label exactly ${JSON.stringify(STAGE3_TITLE)} (shared-name-prefix fallback confirmed).`);
  }

  const { name: stage4Name } = await getAccessibleNameAndRole(cdp, titleSelector(STAGE4_SOLO_TITLE));
  if (stage4Name !== STAGE4_SOLO_TITLE) {
    failures.push(`[${themeName}] Stage 4 (solo) visible label was ${JSON.stringify(stage4Name)}, expected exactly ${JSON.stringify(STAGE4_SOLO_TITLE)} (no "Stage N" prefix at all for a solo Stage).`);
  } else {
    findings.push(`[${themeName}] Stage 4 (solo) visible label is the bare agent name ${JSON.stringify(STAGE4_SOLO_TITLE)}, no "Stage N" prefix.`);
  }

  // Structural regression guard (#6): the literal substring "Stage 4" must never appear anywhere
  // in the transcript's own visible text -- it exists only inside the solo row's `aria-label`
  // override (an attribute, not visible text), confirmed by `SubagentChainRow.tsx`'s own comment
  // ("Stage N of M lives ONLY in the accessible name, not the visible label"). Plain `textContent`
  // is the right tool here: this is a structural absence check, not a naming claim.
  const transcriptText = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.textContent ?? ''`);
  if (transcriptText.includes('Stage 4')) {
    failures.push(`[${themeName}] REGRESSION: the literal text "Stage 4" appears visibly in the transcript -- the solo Stage must render with no "Stage N" header at all (identical to a bare SubagentRow).`);
  } else {
    findings.push(`[${themeName}] No "Stage 4" text anywhere in the visible transcript -- the solo Stage renders with no header, as FR-067 requires.`);
  }
}

/** Issue #941 grill item 2: every finished agent/Stage gets a green icon AND green label text
 * (`statusGlyph.ts`'s `success-done` key, `subagentStatus.tsx`'s `SUBAGENT_SUCCESS_TEXT_CLASS`).
 * Measured against the theme's own resolved `--severity-success`, not a hardcoded hex, the same
 * `resolveCssVarColor` pattern `verify-937-advisor-chip.mjs`'s own contrast check uses. */
export async function assertGreenFinished(cdp, findings, failures, themeName) {
  const expectedColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
  const rows = [
    ['Stage 1 header', STAGE1_TITLE],
    ['Stage 2 header', STAGE2_TITLE],
    ['Stage 3 header', STAGE3_TITLE],
    ['Stage 4 (solo) row', STAGE4_SOLO_TITLE]
  ];
  for (const [label, titleText] of rows) {
    const styles = await cdp.evaluate(`(() => {
      const span = ${titleSelector(titleText)};
      if (!span) return null;
      const row = span.closest('[data-slot="collapsible-trigger"]') ?? span.parentElement;
      const icon = row?.querySelector('svg');
      return { labelColor: getComputedStyle(span).color, iconColor: icon ? getComputedStyle(icon).color : null };
    })()`);
    if (!styles) {
      failures.push(`[${themeName}] Could not measure ${label}'s own computed colour (row not found).`);
      continue;
    }
    if (styles.labelColor !== expectedColor) {
      failures.push(`[${themeName}] ${label}'s own label text colour is ${styles.labelColor}, expected the theme's --severity-success (${expectedColor}).`);
    } else if (styles.iconColor !== expectedColor) {
      failures.push(`[${themeName}] ${label}'s own icon colour is ${styles.iconColor}, expected the theme's --severity-success (${expectedColor}).`);
    } else {
      findings.push(`[${themeName}] ${label}: icon and label text both resolve to --severity-success (${expectedColor}), as issue #941 requires for a finished agent/Stage.`);
    }
  }
}

/** Issue #941 grill item 4 (context on expand) and item 4's member-row one-line summary
 * (`ToolRow.tsx`'s `SubagentRow`, `resultSummary`): expanding Stage 1 reveals its own batch
 * context, and BOTH members show their own result's first line with no need to also expand the
 * member row itself (`aria-expanded` stays false on the member's own nested trigger). */
export async function assertDetailsOnExpand(cdp, findings, failures, themeName) {
  await expandRow(cdp, STAGE1_TITLE);
  await cdp.waitFor(
    `${titleSelector(STAGE1_TITLE)}.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')?.textContent.includes('Quality gate for #923') ?? false`,
    { timeoutMs: 10_000, label: `[${themeName}] Stage 1 expanded content shows its own context` }
  ).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const contentText = await cdp.evaluate(
    `${titleSelector(STAGE1_TITLE)}.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')?.textContent ?? ''`
  );
  if (!contentText.includes('Quality gate for #923')) {
    failures.push(`[${themeName}] Stage 1's expanded content does not show its own batch context ("Quality gate for #923").`);
  } else {
    findings.push(`[${themeName}] Stage 1's expanded content shows its own batch context Markdown.`);
  }
  for (const [name, resultFirstLine] of [
    ['G923Code', 'Reviewed the code for #923.'],
    ['G923Arch', 'Reviewed the architecture for #923.']
  ]) {
    if (!contentText.includes(resultFirstLine)) {
      failures.push(`[${themeName}] Stage 1 expanded content does not show ${name}'s own one-line result summary (${JSON.stringify(resultFirstLine)}) without needing to also expand that member row.`);
      continue;
    }
    const memberExpanded = await cdp.evaluate(
      `(() => { const span = document.querySelector('[title=${JSON.stringify(name)}]'); const trigger = span?.closest('[data-slot="collapsible-trigger"]'); return trigger?.getAttribute('aria-expanded') ?? null; })()`
    );
    if (memberExpanded === 'true') {
      failures.push(`[${themeName}] ${name}'s own member row is unexpectedly expanded (aria-expanded="true") -- its one-line summary should be visible WITHOUT expanding it.`);
    } else {
      findings.push(`[${themeName}] ${name}'s own one-line result summary (${JSON.stringify(resultFirstLine)}) is visible the moment Stage 1 is expanded, with its own row still collapsed (aria-expanded=${JSON.stringify(memberExpanded)}).`);
    }
  }
}

/** Issue #941 grill item 5: Stage 2's real "Uses: G923Code (Stage 1)" dependency, the dropped
 * unmatched `agent://NoSuchAgent` reference, and Stage 1/Stage 3's own absence of any "Uses:"
 * line at all (`StageDependencies.tsx`'s `StageUsesLine`, `groupSubagentStages.ts`'s
 * `applyDependencies`). Also confirms clicking the real `G923Code` button opens the Subagent
 * panel with that agent selected (`SubagentPanel.tsx`'s own `aria-selected`). */
export async function assertDependencies(cdp, findings, failures, themeName) {
  await expandRow(cdp, STAGE2_TITLE);
  await cdp.waitFor(
    `${titleSelector(STAGE2_TITLE)}.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')?.textContent.includes('Uses:') ?? false`,
    { timeoutMs: 10_000, label: `[${themeName}] Stage 2 expanded, Uses: line visible` }
  ).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const stage2ContentText = await cdp.evaluate(
    `${titleSelector(STAGE2_TITLE)}.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')?.textContent ?? ''`
  );
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
    const text = await cdp.evaluate(
      `${titleSelector(titleText)}.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')?.textContent ?? ''`
    );
    if (text.includes('Uses:')) {
      failures.push(`[${themeName}] ${label} unexpectedly shows a "Uses:" line (it has no real inbound dependency): ${JSON.stringify(text.slice(0, 120))}`);
    } else {
      findings.push(`[${themeName}] ${label} shows no "Uses:" line, as expected (no real dependency).`);
    }
  }

  // Clicking the real G923Code button opens the Subagent panel with that agent selected.
  await cdp.clickByLabel('Go to G923Code, Stage 1');
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: `[${themeName}] Subagent panel opened from Stage 2's Uses: button` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const selectedRowText = await cdp.evaluate(
    `document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]')?.textContent ?? null`
  );
  if (!selectedRowText || !selectedRowText.includes('G923Code')) {
    failures.push(`[${themeName}] Clicking the "Uses:" G923Code button did not select G923Code's own row in the Subagent panel (selected row text: ${JSON.stringify(selectedRowText)}).`);
  } else {
    findings.push(`[${themeName}] Clicking the real "Uses:" G923Code button opened the Subagent panel with G923Code's own row selected.`);
  }
  await cdp.click(`document.querySelector('[data-panel-close]')`).catch(() => {});
  await cdp.waitFor(`!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: `[${themeName}] Subagent panel closed` }).catch(() => {});
}

/** Issue #941 grill item 5/decision 6: with 4 Stages the per-turn "Subagents" chain row renders
 * (`SubagentChainRow.tsx`, `stages.length >= 2`), and its own compact `ChainStageLine` entries
 * show each Stage's label and green finished agent names, matching the in-place rows. */
export async function assertChainRow(cdp, findings, failures, themeName) {
  const chainTriggerFinder = `Array.from(document.querySelectorAll('[aria-label="Transcript"] [data-slot="collapsible-trigger"]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Subagents, '))`;
  const chainPresent = await cdp.evaluate(`!!(${chainTriggerFinder})`);
  if (!chainPresent) {
    failures.push(`[${themeName}] The per-turn "Subagents" chain row did not render despite this turn having 4 Stages (stages.length >= 2, FR-065).`);
    return;
  }
  findings.push(`[${themeName}] The per-turn "Subagents" chain row rendered (4 Stages in this turn).`);
  await cdp.click(chainTriggerFinder);
  await cdp.waitFor(`document.querySelectorAll('[aria-label="Transcript"] [role="group"]').length >= 4`, { timeoutMs: 10_000, label: `[${themeName}] Chain row expanded, 4 ChainStageLine entries visible` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const groups = await cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label="Transcript"] [role="group"]')).map((el) => el.getAttribute('aria-label') ?? '')`);
  const expectedSubstrings = ['Stage 1 \u00b7 Quality gate for #923', 'Stage 2 \u00b7 Build the fix for #559 and #560.', 'Stage 3 \u00b7 R8', 'Stage 4'];
  for (const expected of expectedSubstrings) {
    if (!groups.some((g) => g.includes(expected))) {
      failures.push(`[${themeName}] No ChainStageLine entry's own aria-label contains ${JSON.stringify(expected)} (found: ${JSON.stringify(groups)}).`);
    } else {
      findings.push(`[${themeName}] ChainStageLine entry found for ${JSON.stringify(expected)}.`);
    }
  }
  const expectedColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
  const chainAgentColors = await cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label="Transcript"] [role="group"] span')).filter((el) => el.textContent.trim() === 'G923Code').map((el) => getComputedStyle(el).color)`);
  if (chainAgentColors.length === 0 || !chainAgentColors.every((c) => c === expectedColor)) {
    failures.push(`[${themeName}] G923Code's own name in the chain row's ChainAgentEntry is not green (${JSON.stringify(chainAgentColors)}, expected ${expectedColor}).`);
  } else {
    findings.push(`[${themeName}] G923Code's own name in the chain row's ChainAgentEntry is green, matching the in-place Stage row.`);
  }
}
