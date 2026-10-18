// Shared driving/assertion helpers for `scripts/verify-941-stage-naming.mjs` (issue #941: Stage
// naming, the one green exception for a finished Subagent/Stage, the Stage's own batch context
// on expansion, real "Uses:" dependencies, the per-turn Subagent chain row, and the now-UNIFIED
// solo-vs-multi-agent Stage header), split out to stay under the #806 600-line file-size cap.
//
// Gate round 1 rewrite: EVERY Stage (solo or not) gets the same header via `stageHeading()`
// (`./stageMeta.ts`), a muted roll-up ("N done"/"N done, M failed") plus a muted duration AND
// start time, all inside `meta`; expanded content order is `StageContextBrief` (only when
// `group.context` is set), then `StageUsesLine`, then either `SubagentBody` (solo) or a
// `SpineList` of `SubagentRow`s (multi).
//
// Gate round 2 rewrite (items 9-12, re-grep-verified against the real current source):
//  - Item 9: `switchTheme` (`verify-tauri-scratch-helpers.mjs`, grep-confirmed) only flips a
//    live class -- it never reloads the app -- so a row a PRIOR theme pass already expanded is
//    STILL expanded on a later pass. Every expand-cycle helper below (`expandByFinder`,
//    `assertExpandCycleByFinder`, used by every Stage row AND the chain row) now reads the
//    REAL starting `aria-expanded` value and only asserts it is a known boolean string, never
//    that it must be "false" -- `expandByFinder` itself only clicks when not already expanded.
//  - Item 10: `StageContextBrief.tsx` no longer applies `inert` to its own container (confirmed
//    by re-reading it in full) -- only an overflowing FOCUSABLE descendant gets
//    `tabindex="-1"` while collapsed, restored on expand/no-longer-overflowing. The fixture's
//    Stage 7 now places its own Markdown heading AND a focusable link near the END of a longer
//    body; `assertContextBriefOverflow` checks both, each via an independent `if` (never an
//    `if`/`else if` chain that would silently skip a later check).
//  - Item 11: a new Stage 8 (no context, names share only a prefix) exercises
//    `sharedNamePrefix`'s "Stage N · <prefix>" fallback; a new `assertStageMetaRollup` checks
//    the exact "N done"/"N done, M failed" wording together with a rendered duration AND
//    "started <time>" in the same trigger; Stage 1/Stage 3's "no Uses:" check now expands first
//    (`CollapsedLine.tsx`'s own comment confirms Radix unmounts `CollapsibleContent` while
//    closed, so an unexpanded check was a guaranteed-trivial pass, never a real negative).
//  - Item 12: a new Stage 9 (solo, NO context) plus the existing Stage 6 (solo, WITH context)
//    are both checked by `assertSoloAgentName` for the agent's own name appearing in the
//    visible row either way; a new Stage 10 (borderline-length context) plus
//    `assertNarrowViewportOverflow` prove the `ResizeObserver` genuinely re-measures on a real
//    narrow-viewport layout change, via the same `Emulation.setDeviceMetricsOverride` precedent
//    `verify-tauri-569.mjs`/`verify-557-thought-runs.mjs` already establish.
//
// Selector strategy unchanged: `CollapsedLine.tsx` sets a plain `title` attribute on a Stage/
// member row's own visible label SPAN whenever that label is a literal string -- a real,
// source-grounded way to find one exact row without guessing at the FULL accessible name
// (`triggerAriaLabel`, a longer, different string). The Naming assertion reads the label SPAN's
// own accessible name via `Accessibility.getPartialAXTree` (never `.textContent`); every other
// assertion below that wants visible, non-AX text (meta rollup, solo summary, Uses: lines) reads
// the trigger/content's own `textContent` instead, since `meta`/`summary` render visibly inside
// the always-mounted `CollapsibleTrigger`, not only in `triggerAriaLabel`.
//
// `SubagentPanel.tsx` re-grep-verified (gate round 2, item 11): still `role="tree"`/
// `role="treeitem"`/`aria-selected={row.node.id === selectedId}` -- unchanged from gate round 1.
// It carries no `data-tool-call-id`/`data-spec-index` attribute at all (grep-confirmed: neither
// identifier appears anywhere in this component), so a repeated agent name's two panel rows are
// genuinely indistinguishable in the DOM beyond their own rendered duration text once both carry
// `aria-selected="true"` (the pre-existing, already-documented `SubagentSummary.id` name-based
// ambiguity) -- the duration-text check below is not a weaker proxy standing in for a stronger
// one that exists in the DOM; it is the strongest claim this component's real markup supports.
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

// Issue #941 grill item 3's three-tier naming rule, exercised across ten Stages (gate round 2
// adds 8-10 to gate round 1's 1-7): Stage 1 (heading-skip), Stage 2 (plain first-line), Stage 3
// (no context AND no shared name prefix -- a bare "Stage N"), Stage 4 (first line over 60 chars
// -- truncate-with-ellipsis), Stage 5 (plain first-line, 2nd "Story559" occurrence), Stage 6
// (SOLO, WITH context -- gets the uniform header, its own agent name as `summary`), Stage 7 (a
// long, multi-line context with its own Markdown heading AND a focusable link, both placed near
// the end), Stage 8 (no context, names share only a prefix -- `sharedNamePrefix` fallback),
// Stage 9 (SOLO, NO context -- its own name becomes the WHOLE label), Stage 10 (a
// borderline-length context used only for the narrow-viewport `ResizeObserver` check).
export const STAGE1_TITLE = 'Stage 1 \u00b7 Quality gate for #923';
export const STAGE2_TITLE = 'Stage 2 \u00b7 Build the fix for #559 and #560.';
export const STAGE3_TITLE = 'Stage 3';
export const STAGE4_TITLE = 'Stage 4 \u00b7 Review the extremely long and thoroughly verbose first line\u2026';
export const STAGE5_TITLE = 'Stage 5 \u00b7 Finish the remaining Story559 polish and run the fail probe.';
export const STAGE6_SOLO_TITLE = 'Stage 6 \u00b7 Final solo check building on agent://Story559.';
export const STAGE7_TITLE = "Stage 7 \u00b7 Deep investigation for Stage seven's extended context brief.";
// Gate round 2 fix (item 11a): no context, "PfxOne"/"PfxTwo" share only a 3-char prefix ("Pfx")
// and nothing else to label from -- `sharedNamePrefix`'s own fallback, never exercised before.
export const STAGE8_PREFIX_TITLE = 'Stage 8 \u00b7 Pfx';
// Gate round 2 fix (item 12): SOLO, NO context -- `computeStageLabel` returns `names[0]`
// directly for a one-agent Stage with no usable context label (gate round 2 architect fix,
// item 1), so the agent's own name becomes the WHOLE label, not a bare "Stage 9".
export const STAGE9_SOLO_NOCTX_TITLE = 'Stage 9 \u00b7 SoloBare';
// Gate round 2 fix (item 12): a single continuous paragraph (no explicit line breaks) long
// enough to sit right at the ~6-line/144px collapsed cap at a normal composer width, chosen so
// narrowing the window (not merely re-rendering) is what pushes it over -- `assertNarrowView-
// portOverflow` is the only check that opens this Stage.
export const STAGE10_BORDERLINE_TITLE =
  "Stage 10 \u00b7 This paragraph intentionally stays within the brief's own si\u2026";
// The one plain, non-Stage tool call in this turn (issue #941 regression guard 2: "tool rows
// stay neutral, never green") -- `read` is not in `COMMAND_STYLE_TOOLS` (`formatToolCommand.ts`),
// so its solo `CollapsedLine` gets a literal `label={item.tool}` = `'read'`, carrying its own
// `title="read"` the same way a Stage/member label does.
export const PLAIN_TOOL_TITLE = 'read';

export function titleSelector(titleText) {
  return `document.querySelector('[title=${JSON.stringify(titleText)}]')`;
}

export function stageContentSelector(titleText) {
  return `${titleSelector(titleText)}.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')`;
}

export function stageTriggerSelector(titleText) {
  return `${titleSelector(titleText)}.closest('[data-slot="collapsible-trigger"]')`;
}

/** Gate round 2 fix (item 9): generalized over any trigger-finding JS expression (a Stage's own
 * title-keyed trigger, or the chain row's own `aria-label`-keyed trigger) -- reads the REAL
 * current `aria-expanded` value and only clicks when it is not already `'true'`. Driving the
 * SAME scenario across three themes in one script run never re-collapses a row a PRIOR theme's
 * own pass already expanded: `switchTheme` (grep-verified) only flips a live class and never
 * reloads the app or resets React state, so without this guard a later pass would immediately
 * re-collapse a row the first pass already expanded. */
export async function expandByFinder(cdp, triggerFinderExpr) {
  const isExpanded = await cdp.evaluate(`(${triggerFinderExpr})?.getAttribute('aria-expanded') === 'true'`);
  if (!isExpanded) await cdp.click(triggerFinderExpr);
}

export async function expandRow(cdp, titleText) {
  await expandByFinder(cdp, stageTriggerSelector(titleText));
}

/** Gate round 2 fix (item 9): asserts a trigger's own `aria-expanded` is a KNOWN boolean string
 * (`'true'` or `'false'`) before expanding -- never specifically `'false'`, since a prior theme
 * pass in the SAME run may have already expanded this exact row (see the module header) -- and
 * is exactly `'true'` after. Generalized over any trigger-finding JS expression so the chain
 * row's own expand click gets the identical guard (previously it had none at all). */
export async function assertExpandCycleByFinder(cdp, triggerFinderExpr, findings, failures, themeName, label) {
  const before = await cdp.evaluate(`(${triggerFinderExpr})?.getAttribute('aria-expanded') ?? null`);
  if (before !== 'true' && before !== 'false') {
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

async function assertExpandCycle(cdp, titleText, findings, failures, themeName, label) {
  await assertExpandCycleByFinder(cdp, stageTriggerSelector(titleText), findings, failures, themeName, label);
}

/** Issue #941 grill item 3 (Naming): all ten Stages' own visible labels, including Stage 3's
 * bare "Stage 3", Stage 4's exact truncate-with-ellipsis rule, Stage 8's `sharedNamePrefix`
 * fallback (gate round 2, item 11a), and Stage 9's solo-no-context whole-name label (gate round
 * 2, item 12). Stage 10's own label is checked here too (it is otherwise only ever expanded by
 * `assertNarrowViewportOverflow`, which does not re-check its visible text). */
export async function assertStageNaming(cdp, findings, failures, themeName) {
  const expectations = [
    ['Stage 1', STAGE1_TITLE, 'heading-only "# Goal" line skipped, second line used'],
    ['Stage 2', STAGE2_TITLE, 'plain first-line path, no heading this time'],
    ['Stage 3', STAGE3_TITLE, 'no context at all AND no shared name prefix -- bare "Stage N", no "\u00b7 label"'],
    ['Stage 4', STAGE4_TITLE, 'first line over 60 chars -- exact truncate-with-ellipsis rule'],
    ['Stage 5', STAGE5_TITLE, 'plain first-line path (also holds the 2nd "Story559" occurrence)'],
    ['Stage 6 (solo, with context)', STAGE6_SOLO_TITLE, 'solo Stage, context-derived label -- UNIFORM header, same as every multi-agent Stage'],
    ['Stage 7', STAGE7_TITLE, 'long multi-line context with its own Markdown heading, now near the end'],
    ['Stage 8', STAGE8_PREFIX_TITLE, 'no context, names share only a 3-char prefix -- sharedNamePrefix fallback'],
    ['Stage 9 (solo, no context)', STAGE9_SOLO_NOCTX_TITLE, 'solo Stage, NO context -- its own agent name is the WHOLE label'],
    ['Stage 10', STAGE10_BORDERLINE_TITLE, 'borderline-length context (narrow-viewport ResizeObserver check only)']
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

/** Issue #941 grill items 1/2 (gate round 2 item 12): a solo Stage's own visible label/
 * accessible name CONTAINS the agent's own name either way it can arise -- Stage 9 (no context)
 * has the agent's name AS its whole label; Stage 6 (with context) shows the context label as
 * the Stage's own label AND the agent's name again as `CollapsedLine`'s own `summary` slot,
 * visible in the trigger's `textContent` while still collapsed (summary renders inside the
 * always-mounted trigger, never inside `CollapsibleContent`, so no expand is needed here). */
export async function assertSoloAgentName(cdp, findings, failures, themeName) {
  const noCtxText = await cdp.evaluate(`${stageTriggerSelector(STAGE9_SOLO_NOCTX_TITLE)}?.textContent ?? ''`);
  if (!noCtxText.includes('SoloBare')) {
    failures.push(`[${themeName}] Stage 9 (solo, no context)'s own trigger does not contain its sole agent's name "SoloBare" (got: ${JSON.stringify(noCtxText)}).`);
  } else {
    findings.push(`[${themeName}] Stage 9 (solo, no context)'s own visible label IS its sole agent's name "SoloBare" (computeStageLabel's own names.length === 1 fallback, gate round 2 item 1).`);
  }
  const withCtxText = await cdp.evaluate(`${stageTriggerSelector(STAGE6_SOLO_TITLE)}?.textContent ?? ''`);
  if (!withCtxText.includes('Story559')) {
    failures.push(`[${themeName}] Stage 6 (solo, with context)'s own trigger does not show its sole agent's name "Story559" alongside its context-derived label (got: ${JSON.stringify(withCtxText)}).`);
  } else {
    findings.push(`[${themeName}] Stage 6 (solo, with context)'s own trigger shows its sole agent's name "Story559" as CollapsedLine's own summary slot, alongside its context-derived label.`);
  }
}

/** Issue #941 grill item 3 (gate round 2 fix, item 11b): a settled Stage's own `meta` slot shows
 * the exact "N done"/"N done, M failed" counts wording (never "finished", never a bare agent
 * count) TOGETHER WITH a rendered duration AND a "started <time>" text, all inside the same
 * `CollapsibleTrigger` (`SubagentChainRow.tsx`'s own `joinMetaParts` build) -- read via the
 * trigger's own `textContent`, since `meta` renders visibly there, not only in
 * `triggerAriaLabel`. Stage 1 (every agent finished) and Stage 5 (one finished, one failed)
 * cover both wording shapes. */
export async function assertStageMetaRollup(cdp, findings, failures, themeName) {
  const expectations = [
    ['Stage 1', STAGE1_TITLE, '2 done'],
    ['Stage 5', STAGE5_TITLE, '1 done, 1 failed']
  ];
  for (const [label, titleText, countsText] of expectations) {
    const text = await cdp.evaluate(`${stageTriggerSelector(titleText)}?.textContent ?? ''`);
    if (!text.includes(countsText)) {
      failures.push(`[${themeName}] ${label}'s own trigger does not show the exact counts wording ${JSON.stringify(countsText)} (got: ${JSON.stringify(text)}).`);
    } else {
      findings.push(`[${themeName}] ${label}'s own trigger shows the exact counts wording ${JSON.stringify(countsText)}.`);
    }
    if (!/\b\d+[hms]\b/.test(text)) {
      failures.push(`[${themeName}] ${label}'s own trigger does not show a rendered duration (expected a formatElapsed-shaped token, e.g. "3s"/"1m 14s"): ${JSON.stringify(text)}.`);
    } else {
      findings.push(`[${themeName}] ${label}'s own trigger shows a rendered duration.`);
    }
    if (!/started \d{1,2}:\d{2}/.test(text)) {
      failures.push(`[${themeName}] ${label}'s own trigger does not show "started <time>" text: ${JSON.stringify(text)}.`);
    } else {
      findings.push(`[${themeName}] ${label}'s own trigger shows "started <time>" text, together with its counts and duration, in the same meta slot.`);
    }
  }
}

/** Issue #941 grill item 2: every finished agent/Stage gets a green icon AND green label text
 * (`statusGlyph.ts`'s `success-done` key, `subagentStatus.tsx`'s `SUBAGENT_SUCCESS_TEXT_CLASS`).
 * Measured against the theme's own resolved `--severity-success`, not a hardcoded hex. Also
 * measures a MEMBER row INSIDE an expanded multi-agent Stage, each cross-checked at a measured
 * 4.5:1 contrast ratio against its own rendered background; also confirms Stage 5's own FAILED
 * agent (`FailAgent`) is NOT green. */
export async function assertGreenFinished(cdp, findings, failures, themeName) {
  const expectedColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
  const finishedRows = [
    ['Stage 1 header', STAGE1_TITLE],
    ['Stage 2 header', STAGE2_TITLE],
    ['Stage 3 header', STAGE3_TITLE],
    ['Stage 4 header', STAGE4_TITLE],
    ['Stage 5 header', STAGE5_TITLE],
    ['Stage 6 (solo) header', STAGE6_SOLO_TITLE],
    ['Stage 7 header', STAGE7_TITLE],
    ['Stage 8 header', STAGE8_PREFIX_TITLE],
    ['Stage 9 (solo) header', STAGE9_SOLO_NOCTX_TITLE]
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

  // A MEMBER row inside an expanded multi-agent Stage, not only the Stage header -- Stage 1's
  // own G923Code member (title-unique: no other "G923Code" exists).
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
 * member row itself. */
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

/** Issue #941 grill item 5/decision 6: with ten Stages the per-turn "Subagents" chain row
 * renders (`SubagentChainRow.tsx`, `stages.length >= 2`), and its own compact `ChainStageLine`
 * entries show each Stage's label (speech form) and green finished agent names, matching the
 * in-place rows. Gate round 2 fix (item 9): the chain row's own expand click now goes through
 * the same `aria-expanded`-aware guard every Stage row uses, since a prior theme pass in this
 * same run may have already expanded it. */
export async function assertChainRow(cdp, findings, failures, themeName) {
  const chainTriggerFinder = `Array.from(document.querySelectorAll('[aria-label="Transcript"] [data-slot="collapsible-trigger"]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Subagents, '))`;
  const chainPresent = await cdp.evaluate(`!!(${chainTriggerFinder})`);
  if (!chainPresent) {
    failures.push(`[${themeName}] The per-turn "Subagents" chain row did not render despite this turn having 10 Stages (stages.length >= 2, FR-065).`);
    return;
  }
  findings.push(`[${themeName}] The per-turn "Subagents" chain row rendered (10 Stages in this turn).`);
  await assertExpandCycleByFinder(cdp, chainTriggerFinder, findings, failures, themeName, 'The chain row');
  await cdp.waitFor(`document.querySelectorAll('[aria-label="Transcript"] [role="group"]').length >= 10`, { timeoutMs: 10_000, label: `[${themeName}] Chain row expanded, 10 ChainStageLine entries visible` }).catch((err) => failures.push(`[${themeName}] ${err.message}`));
  const groups = await cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label="Transcript"] [role="group"]')).map((el) => el.getAttribute('aria-label') ?? '')`);
  const expectedSubstrings = [
    'Stage 1, Quality gate for #923',
    'Stage 2, Build the fix for #559 and #560.',
    'Stage 3,',
    'Stage 4, Review the extremely long and thoroughly verbose first line\u2026',
    'Stage 5, Finish the remaining Story559 polish and run the fail probe.',
    'Stage 6, Final solo check building on agent://Story559.',
    "Stage 7, Deep investigation for Stage seven's extended context brief.",
    'Stage 8, Pfx',
    'Stage 9, SoloBare',
    "Stage 10, This paragraph intentionally stays within the brief's own si\u2026"
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
