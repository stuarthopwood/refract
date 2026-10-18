// Shared driving/assertion helpers for `scripts/verify-941-stage-naming.mjs` (issue #941: Stage
// naming, the one green exception for a finished Subagent/Stage, the Stage's own batch context
// on expansion, real "Uses:" dependencies, the per-turn Subagent chain row, and the now-UNIFIED
// solo-vs-multi-agent Stage header), split out to stay under the #806 600-line file-size cap.
//
// Gate round 1 rewrite: the original version of this file was written against the SUPERSEDED
// DOM contract (solo Stage renders with no header at all, `summary=` prop, "Go to X, Stage N"
// button names). It is now rewritten against the real, current contract: EVERY Stage (solo or
// not) gets the same header via `stageHeading()` (`./stageMeta.ts`), a muted roll-up ("N done"/
// "N done, M failed") plus a muted duration AND start time, all inside `meta`; expanded content
// order is `StageContextBrief` (only when `group.context` is set), then `StageUsesLine`, then
// either `SubagentBody` (solo) or a `SpineList` of `SubagentRow`s (multi) -- grep-verified
// against `SubagentChainRow.tsx`, `StageContextBrief.tsx`, `StageDependencies.tsx`,
// `stageMeta.ts`, `ToolRow.tsx`, `subagentStatus.tsx`, `CollapsedLine.tsx`, `collapsible.tsx`.
//
// Selector strategy unchanged: `CollapsedLine.tsx` sets a plain `title` attribute on a Stage/
// member row's own visible label SPAN whenever that label is a literal string (`title={typeof
// label === 'string' ? label : undefined}`, line ~132) -- a real, source-grounded way to find
// one exact row without guessing at the FULL accessible name (`triggerAriaLabel`, a longer,
// different string). The Naming assertion below reads the label SPAN's own accessible name via
// `Accessibility.getPartialAXTree` (never `.textContent`) -- that span carries no `aria-label`
// override of its own (only its ancestor button does), so its AX name is still computed from its
// own content, giving back exactly the rendered label text, through AX, not through `textContent`.
//
// Gate round 1 fix (item 13, CRITICAL): `resolveCssVarColor` is exported by `verify-tauri-cdp.mjs`
// (grep-verified: `export async function resolveCssVarColor(cdp, varName, property)`), NOT by
// `verify-tauri-scratch-helpers.mjs` (which only re-exports `launchViaJobObject`/`sleep` from
// that same module) -- the previous import here named the wrong source module. `node --check`
// cannot catch this (a missing/undefined import only throws once the importing function is
// actually CALLED, at runtime); fixed below, and proven by actually loading this module with a
// real `import()`, not just a syntax check (see the main script's own header for the exact
// command run and its output).

import { mkdirSync, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchViaJobObject } from './verify-tauri-cdp.mjs';
import { resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { getAccessibleNameAndRole } from './verify-tauri-scratch-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';

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
  const env = {
    ...process.env,
    PATH: `${pathPrepend}${path.delimiter}${process.env.PATH ?? ''}`,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    REFRACT_CDP_PORT: String(port),
    ...extraEnv
  };
  const logStream = createWriteStream(logFile);
  const { child, targetPid } = await launchViaJobObject(launcherExe, [exePath], { env, stdio: ['ignore', logStream, logStream] });
  return { child, targetPid };
}

// Issue #941 grill item 3's three-tier naming rule, exercised across seven Stages (gate round 1
// rewrite): Stage 1 (heading-skip), Stage 2 (plain first-line), Stage 3 (no context AND no
// shared name prefix -- a bare "Stage N" with no "· label" at all, the genuinely new case item
// 15 asked for), Stage 4 (a first line over 60 chars -- the exact truncate-with-ellipsis rule),
// Stage 5 (plain first-line, also holds the SECOND occurrence of agent name "Story559"), Stage 6
// (SOLO -- one agent -- now gets the SAME header as every multi-agent Stage, FR-079 no longer
// narrows to multi-agent), Stage 7 (a long, multi-line context with its own Markdown heading).
export const STAGE1_TITLE = 'Stage 1 \u00b7 Quality gate for #923';
export const STAGE2_TITLE = 'Stage 2 \u00b7 Build the fix for #559 and #560.';
export const STAGE3_TITLE = 'Stage 3';
export const STAGE4_TITLE = 'Stage 4 \u00b7 Review the extremely long and thoroughly verbose first line\u2026';
export const STAGE5_TITLE = 'Stage 5 \u00b7 Finish the remaining Story559 polish and run the fail probe.';
export const STAGE6_SOLO_TITLE = 'Stage 6 \u00b7 Final solo check building on agent://Story559.';
export const STAGE7_TITLE = "Stage 7 \u00b7 Deep investigation for Stage seven's extended context brief.";
// The one plain, non-Stage tool call in this turn (issue #941 regression guard 2: "tool rows
// stay neutral, never green") -- `read` is not in `COMMAND_STYLE_TOOLS` (`formatToolCommand.ts`),
// so its solo `CollapsedLine` gets a literal `label={item.tool}` = `'read'`, carrying its own
// `title="read"` the same way a Stage/member label does.
export const PLAIN_TOOL_TITLE = 'read';

function titleSelector(titleText) {
  return `document.querySelector('[title=${JSON.stringify(titleText)}]')`;
}

function stageContentSelector(titleText) {
  return `${titleSelector(titleText)}.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')`;
}

function stageTriggerSelector(titleText) {
  return `${titleSelector(titleText)}.closest('[data-slot="collapsible-trigger"]')`;
}

/** Gate round 1 fix (item 14): checks the trigger's own `aria-expanded` before clicking, so
 * driving the SAME scenario across three themes in one script run never re-collapses a row a
 * PRIOR theme's own pass already expanded. `verify-tauri-scratch-helpers.mjs`'s own
 * `switchTheme` (grep-verified) only clicks the profile dropdown's theme submenu item and waits
 * for a class to flip on the live DOM -- it never reloads the app or resets React state -- so
 * this defensive guard is not merely theoretical here: without it, Dark's own pass would expand
 * every row, and Obsidian's pass would immediately re-collapse every one of them right back. */
export async function expandRow(cdp, titleText) {
  const isExpanded = await cdp.evaluate(`${stageTriggerSelector(titleText)}?.getAttribute('aria-expanded') === 'true'`);
  if (!isExpanded) await cdp.click(titleSelector(titleText));
}

/** Asserts a trigger's own `aria-expanded` is the exact STRING `'false'` before expanding and
 * `'true'` after (gate round 1 fix, item 16) -- never `null`/absent either side. */
async function assertExpandCycle(cdp, titleText, findings, failures, themeName, label) {
  const before = await cdp.evaluate(`${stageTriggerSelector(titleText)}?.getAttribute('aria-expanded') ?? null`);
  if (before !== 'false') {
    failures.push(`[${themeName}] ${label}'s own trigger aria-expanded was ${JSON.stringify(before)} before expanding, expected the string "false".`);
  } else {
    findings.push(`[${themeName}] ${label}'s own trigger aria-expanded is the string "false" before expanding.`);
  }
  await expandRow(cdp, titleText);
  const after = await cdp.evaluate(`${stageTriggerSelector(titleText)}?.getAttribute('aria-expanded') ?? null`);
  if (after !== 'true') {
    failures.push(`[${themeName}] ${label}'s own trigger aria-expanded was ${JSON.stringify(after)} after expanding, expected the string "true".`);
  } else {
    findings.push(`[${themeName}] ${label}'s own trigger aria-expanded is the string "true" after expanding.`);
  }
}

/** Issue #941 grill item 3 (Naming), gate round 1 rewrite: all seven Stages' own visible labels,
 * including Stage 3's bare "Stage 3" (no context, no shared name prefix) and Stage 4's exact
 * truncate-with-ellipsis rule. Item 14's inversion: Stage 6 is the SOLO Stage, and -- unlike the
 * superseded FR-067 rule this replaces -- it now gets the SAME "Stage 6 · ..." header as every
 * multi-agent Stage, confirmed below exactly like Stages 1-5/7, never hidden. */
export async function assertStageNaming(cdp, findings, failures, themeName) {
  const expectations = [
    ['Stage 1', STAGE1_TITLE, 'heading-only "# Goal" line skipped, second line used'],
    ['Stage 2', STAGE2_TITLE, 'plain first-line path, no heading this time'],
    ['Stage 3', STAGE3_TITLE, 'no context at all AND no shared name prefix -- bare "Stage N", no "\u00b7 label"'],
    ['Stage 4', STAGE4_TITLE, 'first line over 60 chars -- exact truncate-with-ellipsis rule'],
    ['Stage 5', STAGE5_TITLE, 'plain first-line path (also holds the 2nd "Story559" occurrence)'],
    ['Stage 6 (solo)', STAGE6_SOLO_TITLE, 'solo Stage -- UNIFORM header, no longer special-cased (FR-079 supersedes the old solo-no-header rule)'],
    ['Stage 7', STAGE7_TITLE, 'long multi-line context with its own Markdown heading']
  ];
  for (const [label, titleText, rule] of expectations) {
    const { name } = await getAccessibleNameAndRole(cdp, titleSelector(titleText));
    if (name !== titleText) {
      failures.push(`[${themeName}] ${label}'s own visible label (AX name of its label span) was ${JSON.stringify(name)}, expected exactly ${JSON.stringify(titleText)} (${rule}).`);
    } else {
      findings.push(`[${themeName}] ${label} label exactly ${JSON.stringify(titleText)} (${rule}).`);
    }
  }
}

/** Issue #941 grill item 2: every finished agent/Stage gets a green icon AND green label text
 * (`statusGlyph.ts`'s `success-done` key, `subagentStatus.tsx`'s `SUBAGENT_SUCCESS_TEXT_CLASS`).
 * Measured against the theme's own resolved `--severity-success`, not a hardcoded hex. Gate
 * round 1 fix (item 16): also measures a MEMBER row INSIDE an expanded multi-agent Stage (not
 * only the Stage header itself), each cross-checked at a measured 4.5:1 contrast ratio against
 * its own rendered background (the same `resolveCssVarColor`/`measuredContrastRatio` pattern
 * `verify-925-924-helpers.mjs`'s own `assertDiffStatSpans` already established, reused here
 * rather than re-deriving a second colour-contrast routine); also confirms Stage 5's own FAILED
 * agent (`FailAgent`) is NOT green, the negative case the original version never checked. */
export async function assertGreenFinished(cdp, findings, failures, themeName) {
  const expectedColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
  const finishedRows = [
    ['Stage 1 header', STAGE1_TITLE],
    ['Stage 2 header', STAGE2_TITLE],
    ['Stage 3 header', STAGE3_TITLE],
    ['Stage 4 header', STAGE4_TITLE],
    ['Stage 5 header', STAGE5_TITLE],
    ['Stage 6 (solo) header', STAGE6_SOLO_TITLE],
    ['Stage 7 header', STAGE7_TITLE]
  ];
  for (const [label, titleText] of finishedRows) {
    const styles = await cdp.evaluate(`(() => {
      const span = ${titleSelector(titleText)};
      if (!span) return null;
      const row = span.closest('[data-slot="collapsible-trigger"]') ?? span.parentElement;
      const icon = row?.querySelector('svg');
      const bg = (() => { let node = span; while (node) { const bgc = getComputedStyle(node).backgroundColor; if (bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent') return bgc; node = node.parentElement; } return getComputedStyle(document.body).backgroundColor; })();
      return { labelColor: getComputedStyle(span).color, iconColor: icon ? getComputedStyle(icon).color : null, bg };
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
      findings.push(`[${themeName}] ${label}: icon and label text both resolve to --severity-success (${expectedColor}).`);
      const ratio = measuredContrastRatio(styles.labelColor, styles.bg);
      if (ratio === null) failures.push(`[${themeName}] ${label}: could not parse its own colour/backdrop for a measured contrast ratio.`);
      else if (ratio < 4.5) failures.push(`[${themeName}] ${label} measures ${ratio.toFixed(2)}:1 against its own rendered backdrop, below the 4.5:1 WCAG AA text floor.`);
      else findings.push(`[${themeName}] ${label} measures ${ratio.toFixed(2)}:1 against its own rendered backdrop, clears 4.5:1.`);
    }
  }

  // Gate round 1 fix (item 16): a MEMBER row inside an expanded multi-agent Stage, not only the
  // Stage header -- Stage 1's own G923Code member (title-unique: no other "G923Code" exists).
  await expandRow(cdp, STAGE1_TITLE);
  const memberStyles = await cdp.evaluate(`(() => {
    const span = ${titleSelector('G923Code')};
    if (!span) return null;
    const row = span.closest('[data-slot="collapsible-trigger"]') ?? span.parentElement;
    const icon = row?.querySelector('svg');
    const bg = (() => { let node = span; while (node) { const bgc = getComputedStyle(node).backgroundColor; if (bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent') return bgc; node = node.parentElement; } return getComputedStyle(document.body).backgroundColor; })();
    return { labelColor: getComputedStyle(span).color, iconColor: icon ? getComputedStyle(icon).color : null, bg };
  })()`);
  if (!memberStyles) {
    failures.push(`[${themeName}] Could not measure G923Code's own member-row computed colour inside expanded Stage 1.`);
  } else if (memberStyles.labelColor !== expectedColor || memberStyles.iconColor !== expectedColor) {
    failures.push(`[${themeName}] G923Code's own member row (inside expanded Stage 1) is not fully green: label ${memberStyles.labelColor}, icon ${memberStyles.iconColor}, expected ${expectedColor}.`);
  } else {
    const ratio = measuredContrastRatio(memberStyles.labelColor, memberStyles.bg);
    if (ratio !== null && ratio >= 4.5) {
      findings.push(`[${themeName}] G923Code's own member row (inside expanded Stage 1) is green and measures ${ratio.toFixed(2)}:1 against its own backdrop, matching the Stage header.`);
    } else {
      failures.push(`[${themeName}] G923Code's own member row measures ${ratio === null ? 'an unparseable' : ratio.toFixed(2)}:1 against its own backdrop, below 4.5:1.`);
    }
  }

  // Negative case (fixture item c): Stage 5's own FailAgent is NOT green.
  await expandRow(cdp, STAGE5_TITLE);
  const failedStyles = await cdp.evaluate(`(() => {
    const span = ${titleSelector('FailAgent')};
    if (!span) return null;
    const row = span.closest('[data-slot="collapsible-trigger"]') ?? span.parentElement;
    const icon = row?.querySelector('svg');
    return { labelColor: getComputedStyle(span).color, iconColor: icon ? getComputedStyle(icon).color : null };
  })()`);
  if (!failedStyles) {
    failures.push(`[${themeName}] Could not measure Stage 5's own FailAgent member row.`);
  } else if (failedStyles.labelColor === expectedColor || failedStyles.iconColor === expectedColor) {
    failures.push(`[${themeName}] REGRESSION: Stage 5's own FAILED agent (FailAgent) is green (label ${failedStyles.labelColor}, icon ${failedStyles.iconColor}) -- only a FINISHED agent/Stage gets --severity-success.`);
  } else {
    findings.push(`[${themeName}] Stage 5's own failed agent (FailAgent) is NOT green, as issue #941 requires (only finished is green).`);
  }

  // Regression guard 2 (fixture item h): the one plain, non-Stage `read` tool row stays neutral.
  const plainToolStyles = await cdp.evaluate(`(() => {
    const span = ${titleSelector(PLAIN_TOOL_TITLE)};
    if (!span) return null;
    const row = span.closest('[data-slot="collapsible-trigger"]') ?? span.parentElement;
    const icon = row?.querySelector('svg');
    return { labelColor: getComputedStyle(span).color, iconColor: icon ? getComputedStyle(icon).color : null };
  })()`);
  if (!plainToolStyles) {
    failures.push(`[${themeName}] Could not measure the plain 'read' tool row's own computed colour.`);
  } else if (plainToolStyles.labelColor === expectedColor || plainToolStyles.iconColor === expectedColor) {
    failures.push(`[${themeName}] REGRESSION: the plain 'read' tool row (never a Stage/Subagent) is green (label ${plainToolStyles.labelColor}, icon ${plainToolStyles.iconColor}) -- toolStatus.tsx's own neutral 'done' mapping must never pick up --severity-success.`);
  } else {
    findings.push(`[${themeName}] The plain 'read' tool row stays neutral, never green (toolStatus.tsx's own separate, untouched module).`);
  }
}

/** Issue #941 grill item 4 (context on expand) and item 7 (member-row one-line summary,
 * `ToolRow.tsx`'s `SubagentRow`, `extractResultSummary`): expanding Stage 1 reveals its own batch
 * context, and BOTH members show their own result's first line with no need to also expand the
 * member row itself. Gate round 1 fix (item 16): asserts the trigger's own `aria-expanded` is the
 * exact string "false" before expanding and "true" after. */
export async function assertDetailsOnExpand(cdp, findings, failures, themeName) {
  await assertExpandCycle(cdp, STAGE1_TITLE, findings, failures, themeName, 'Stage 1');
  await cdp.waitFor(`${stageContentSelector(STAGE1_TITLE)}?.textContent.includes('Quality gate for #923') ?? false`, {
    timeoutMs: 10_000,
    label: `[${themeName}] Stage 1 expanded content shows its own context`
  }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const contentText = await cdp.evaluate(`${stageContentSelector(STAGE1_TITLE)}?.textContent ?? ''`);
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
    const memberExpanded = await cdp.evaluate(`${stageTriggerSelector(name)}?.getAttribute('aria-expanded') ?? null`);
    if (memberExpanded === 'true') {
      failures.push(`[${themeName}] ${name}'s own member row is unexpectedly expanded (aria-expanded="true") -- its one-line summary should be visible WITHOUT expanding it.`);
    } else {
      findings.push(`[${themeName}] ${name}'s own one-line result summary (${JSON.stringify(resultFirstLine)}) is visible the moment Stage 1 is expanded, with its own row still collapsed (aria-expanded=${JSON.stringify(memberExpanded)}).`);
    }
  }
}

/** Issue #941 grill item 5: Stage 2's real "Uses: G923Code (Stage 1)" dependency, the dropped
 * unmatched `agent://NoSuchAgent` reference, Stage 1/Stage 3's own absence of any "Uses:" line,
 * clicking the real `G923Code` button to open the Subagent panel with that agent selected, AND
 * (gate round 1 rewrite, fixture items e/f/g):
 *  - Stage 7's own SELF-reference (`agent://LongCtxA`, one of Stage 7's OWN agents) is dropped,
 *    never shown in Stage 7's own "Uses:" (which must not render at all: no other, non-self,
 *    dependency exists there).
 *  - Stage 6 (SOLO) has a real "Uses:" line (proving the solo path is no longer special-cased),
 *    resolving the repeated agent name "Story559" (first in Stage 2, again in Stage 5) to the
 *    LATEST earlier Stage (Stage 5), not Stage 2 -- verified by clicking the real button and
 *    confirming the Subagent panel selects a row carrying Stage 5's own duration (4300ms ->
 *    "4s"), not Stage 2's (1800ms -> "2s"). Caveat (grounded in `SubagentPanel.tsx`'s own
 *    `aria-selected={row.node.id === selectedId}`, read in full): `SubagentSummary.id` is
 *    name-based, so with two live subagents sharing the name "Story559", BOTH their panel rows
 *    end up `aria-selected="true"` once either is selected by id -- a pre-existing app-level
 *    ambiguity this script does not invent or attempt to fix. The assertion below proves the
 *    CORRECT occurrence (Stage 5's, by its own distinct duration) is among the selected rows,
 *    which is the strongest claim actually provable through this component's real selection
 *    model; it does not claim Stage 2's row is excluded. */
export async function assertDependencies(cdp, findings, failures, themeName) {
  await assertExpandCycle(cdp, STAGE2_TITLE, findings, failures, themeName, 'Stage 2');
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
    const text = await cdp.evaluate(`${stageContentSelector(titleText)}?.textContent ?? ''`);
    if (text.includes('Uses:')) {
      failures.push(`[${themeName}] ${label} unexpectedly shows a "Uses:" line (it has no real inbound dependency): ${JSON.stringify(text.slice(0, 120))}`);
    } else {
      findings.push(`[${themeName}] ${label} shows no "Uses:" line, as expected (no real dependency).`);
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
  await cdp.clickByLabel('Open G923Code in Subagents panel');
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: `[${themeName}] Subagent panel opened from Stage 2's Uses: button` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const selectedRowText = await cdp.evaluate(`document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]')?.textContent ?? null`);
  if (!selectedRowText || !selectedRowText.includes('G923Code')) {
    failures.push(`[${themeName}] Clicking the "Uses:" G923Code button did not select G923Code's own row in the Subagent panel (selected row text: ${JSON.stringify(selectedRowText)}).`);
  } else {
    findings.push(`[${themeName}] Clicking the real "Uses:" G923Code button opened the Subagent panel with G923Code's own row selected.`);
  }
  await cdp.click(`document.querySelector('[data-panel-close]')`).catch(() => {});
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
  await cdp.clickByLabel('Open Story559 in Subagents panel');
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: `[${themeName}] Subagent panel opened from Stage 6's Uses: button` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const selectedStory559Durations = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]')).filter((el) => el.textContent.includes('Story559')).map((el) => el.textContent)`);
  if (selectedStory559Durations.some((text) => text.includes('4s'))) {
    findings.push(`[${themeName}] Clicking Stage 6's "Uses:" Story559 button selected the row carrying Stage 5's own duration ("4s", from its 4300ms), proving the LATEST occurrence (not Stage 2's 1800ms/"2s") was resolved by toolCallId+specIndex, not name alone.`);
  } else {
    failures.push(`[${themeName}] No selected Subagent row carries Stage 5's own duration ("4s") after clicking Stage 6's "Uses:" Story559 button (selected rows: ${JSON.stringify(selectedStory559Durations)}).`);
  }
  await cdp.click(`document.querySelector('[data-panel-close]')`).catch(() => {});
  await cdp.waitFor(`!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: `[${themeName}] Subagent panel closed` }).catch(() => {});
}

/** Fixture item d / issue #941 grill item 4, gate round 1 fix (`StageContextBrief.tsx`, item
 * 14's scoping note): Stage 7's own context is long enough (12 lines, including its own Markdown
 * "## Key considerations" heading) to exceed the ~6-line/144px `max-h-36` cap -- asserts the
 * content IS visually capped (measured: `clientHeight < scrollHeight`, and the heading sits
 * below the visible fold, `inert` while collapsed), the "Show full brief" toggle appears with
 * the correct `aria-expanded` (the exact string "false", then "true"), clicking it reveals the
 * heading (now within the visible fold, `inert` removed), and clicking "Show less" re-collapses
 * it (heading clipped away again, `inert` restored). */
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
    return {
      buttonText: btn.textContent.trim(),
      ariaExpanded: btn.getAttribute('aria-expanded'),
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      headingOffsetTop: heading ? heading.offsetTop : null,
      inert: container.hasAttribute('inert')
    };
  })()`);
  const collapsed = await measure();
  if (!collapsed) {
    failures.push(`[${themeName}] Could not measure Stage 7's own context brief (toggle/container not found).`);
    return;
  }
  if (collapsed.ariaExpanded !== 'false') {
    failures.push(`[${themeName}] Stage 7's "Show full brief" button aria-expanded was ${JSON.stringify(collapsed.ariaExpanded)} while collapsed, expected the string "false".`);
  } else if (collapsed.clientHeight >= collapsed.scrollHeight) {
    failures.push(`[${themeName}] Stage 7's own context brief is not actually capped (clientHeight ${collapsed.clientHeight} >= scrollHeight ${collapsed.scrollHeight}) -- the overflow this test depends on never happened.`);
  } else if (collapsed.headingOffsetTop === null) {
    failures.push(`[${themeName}] Stage 7's own rendered Markdown heading ("## Key considerations") was not found inside its context brief.`);
  } else if (collapsed.headingOffsetTop < collapsed.clientHeight) {
    failures.push(`[${themeName}] Stage 7's own Markdown heading is already within the visible, collapsed fold (offsetTop ${collapsed.headingOffsetTop} < clientHeight ${collapsed.clientHeight}) -- it should be clipped away until expanded.`);
  } else if (!collapsed.inert) {
    failures.push(`[${themeName}] Stage 7's own collapsed-and-overflowing context brief container is missing the 'inert' attribute.`);
  } else {
    findings.push(`[${themeName}] Stage 7's own context brief is visually capped (clientHeight ${collapsed.clientHeight} < scrollHeight ${collapsed.scrollHeight}), its own Markdown heading sits below the visible fold (offsetTop ${collapsed.headingOffsetTop}) and carries 'inert' while collapsed.`);
  }

  await cdp.click(briefButtonFinder);
  await cdp.waitFor(`(${briefButtonFinder})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: `[${themeName}] Stage 7's "Show full brief" expanded` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const expanded = await measure();
  if (!expanded) {
    failures.push(`[${themeName}] Could not re-measure Stage 7's own context brief after expanding.`);
  } else if (expanded.ariaExpanded !== 'true') {
    failures.push(`[${themeName}] Stage 7's "Show full brief" button aria-expanded was ${JSON.stringify(expanded.ariaExpanded)} after clicking it, expected the string "true".`);
  } else if (expanded.headingOffsetTop === null || expanded.headingOffsetTop >= expanded.clientHeight) {
    failures.push(`[${themeName}] Stage 7's own Markdown heading is still clipped (offsetTop ${expanded.headingOffsetTop}, clientHeight ${expanded.clientHeight}) after expanding -- it should now be within the visible, grown container.`);
  } else if (expanded.inert) {
    failures.push(`[${themeName}] Stage 7's own context brief container still carries 'inert' after expanding.`);
  } else {
    findings.push(`[${themeName}] Expanding Stage 7's "Show full brief" reveals its own Markdown heading (now offsetTop ${expanded.headingOffsetTop} < grown clientHeight ${expanded.clientHeight}), inert removed.`);
  }

  await cdp.click(briefButtonFinder);
  await cdp.waitFor(`(${briefButtonFinder})?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: `[${themeName}] Stage 7's "Show less" re-collapsed` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const reCollapsed = await measure();
  if (!reCollapsed) {
    failures.push(`[${themeName}] Could not re-measure Stage 7's own context brief after re-collapsing.`);
  } else if (reCollapsed.ariaExpanded !== 'false') {
    failures.push(`[${themeName}] Stage 7's "Show less" button aria-expanded was ${JSON.stringify(reCollapsed.ariaExpanded)} after clicking it, expected the string "false".`);
  } else if (reCollapsed.headingOffsetTop === null || reCollapsed.headingOffsetTop < reCollapsed.clientHeight || !reCollapsed.inert) {
    failures.push(`[${themeName}] Stage 7's own context brief did not re-collapse correctly (offsetTop ${reCollapsed.headingOffsetTop}, clientHeight ${reCollapsed.clientHeight}, inert ${reCollapsed.inert}).`);
  } else {
    findings.push(`[${themeName}] Clicking "Show less" re-collapses Stage 7's own context brief: heading clipped away again (offsetTop ${reCollapsed.headingOffsetTop} >= clientHeight ${reCollapsed.clientHeight}), inert restored.`);
  }
}

/** Issue #941 grill item 5/decision 6: with seven Stages the per-turn "Subagents" chain row
 * renders (`SubagentChainRow.tsx`, `stages.length >= 2`), and its own compact `ChainStageLine`
 * entries show each Stage's label (speech form -- `stageHeading(..., true)`, a comma, matching
 * the REAL `aria-label` this component builds, gate round 1 fix: the previous version of this
 * check compared against the "\u00b7" glyph form, which the real `aria-label` never contains)
 * and green finished agent names, matching the in-place rows. */
export async function assertChainRow(cdp, findings, failures, themeName) {
  const chainTriggerFinder = `Array.from(document.querySelectorAll('[aria-label="Transcript"] [data-slot="collapsible-trigger"]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Subagents, '))`;
  const chainPresent = await cdp.evaluate(`!!(${chainTriggerFinder})`);
  if (!chainPresent) {
    failures.push(`[${themeName}] The per-turn "Subagents" chain row did not render despite this turn having 7 Stages (stages.length >= 2, FR-065).`);
    return;
  }
  findings.push(`[${themeName}] The per-turn "Subagents" chain row rendered (7 Stages in this turn).`);
  const before = await cdp.evaluate(`(${chainTriggerFinder})?.getAttribute('aria-expanded') ?? null`);
  if (before !== 'false') failures.push(`[${themeName}] The chain row's own trigger aria-expanded was ${JSON.stringify(before)} before expanding, expected the string "false".`);
  else findings.push(`[${themeName}] The chain row's own trigger aria-expanded is the string "false" before expanding.`);
  await cdp.click(chainTriggerFinder);
  await cdp.waitFor(`document.querySelectorAll('[aria-label="Transcript"] [role="group"]').length >= 7`, { timeoutMs: 10_000, label: `[${themeName}] Chain row expanded, 7 ChainStageLine entries visible` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const after = await cdp.evaluate(`(${chainTriggerFinder})?.getAttribute('aria-expanded') ?? null`);
  if (after !== 'true') failures.push(`[${themeName}] The chain row's own trigger aria-expanded was ${JSON.stringify(after)} after expanding, expected the string "true".`);
  else findings.push(`[${themeName}] The chain row's own trigger aria-expanded is the string "true" after expanding.`);
  const groups = await cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label="Transcript"] [role="group"]')).map((el) => el.getAttribute('aria-label') ?? '')`);
  const expectedSubstrings = [
    'Stage 1, Quality gate for #923',
    'Stage 2, Build the fix for #559 and #560.',
    'Stage 3,',
    'Stage 4, Review the extremely long and thoroughly verbose first line\u2026',
    'Stage 5, Finish the remaining Story559 polish and run the fail probe.',
    'Stage 6, Final solo check building on agent://Story559.',
    "Stage 7, Deep investigation for Stage seven's extended context brief."
  ];
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
