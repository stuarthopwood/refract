// Shared driving/assertion helpers for `verify-941-stage-naming.mjs` (#941 Stage naming, green finished state, context on expand, chain row), split out for the #806 file-size cap.
// Stages are found by the plain `title` attribute `CollapsedLine.tsx` sets on a literal label span; naming is read via `axText`, other visible text via `textContent`.
import { mkdirSync, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchViaJobObject } from './verify-tauri-cdp.mjs';
import { resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { axText } from './verify-tauri-scratch-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';
import { expandByFinder, expandRow, assertExpandCycleByFinder } from './verify-941-stage-naming-expand-helpers.mjs';
export { expandByFinder, expandRow, assertExpandCycleByFinder } from './verify-941-stage-naming-expand-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

/** Builds the recorded-frame fake `omp` PATH shim (`verify-tauri-omp-shim.rs`). */
export function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** Local `launchBuiltExe` with `pathPrepend`/`extraEnv` restored for the fake-omp shim.
 * Uses WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/WEBVIEW2_USER_DATA_FOLDER: the app never reads REFRACT_CDP_PORT.
 * `launchViaJobObject` takes `pidFile` as its 2nd positional argument. */
export async function launchBuiltExeWithEnv(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...process.env,
    PATH: `${pathPrepend}${path.delimiter}${process.env.PATH ?? ''}`,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv
  };
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

// Ten Stages cover the three-tier naming rule: 1 heading-skip, 2 plain first line, 3 bare "Stage N", 4 truncated first line,
// 5 plain first line (2nd "Story559"), 6 solo with context, 7 long multi-line context with heading and link near the end,
// 8 `sharedNamePrefix` fallback, 9 solo without context, 10 borderline-length context for the narrow-viewport check.
export const STAGE1_TITLE = 'Stage 1 \u00b7 Quality gate for #923';
export const STAGE2_TITLE = 'Stage 2 \u00b7 Build the fix for #559 and #560.';
export const STAGE3_TITLE = 'Stage 3';
export const STAGE4_TITLE = 'Stage 4 \u00b7 Review the extremely long and thoroughly verbose first line\u2026';
export const STAGE5_TITLE = 'Stage 5 \u00b7 Finish the remaining Story559 polish and run the fail probe.';
export const STAGE6_SOLO_TITLE = 'Stage 6 \u00b7 Final solo check building on agent://Story559.';
export const STAGE7_TITLE = "Stage 7 \u00b7 Deep investigation for Stage seven's extended context brief.";
// No context, "PfxOne"/"PfxTwo" share only a 3-char prefix: `sharedNamePrefix` fallback.
export const STAGE8_PREFIX_TITLE = 'Stage 8 \u00b7 Pfx';
// Solo with no context: `computeStageLabel` returns `names[0]`, so the agent name is the whole label.
export const STAGE9_SOLO_NOCTX_TITLE = 'Stage 9 \u00b7 SoloBare';
// One paragraph at the ~6-line/144px collapsed cap, so only narrowing the window pushes it over.
export const STAGE10_BORDERLINE_TITLE =
  "Stage 10 \u00b7 This paragraph intentionally stays within the brief's own si\u2026";
// The plain non-Stage tool row (#941 guard: tool rows stay neutral, never green); `read` gets a literal `title="read"` label.
export const PLAIN_TOOL_TITLE = 'read';

/** Selector for the message-scroller row with this exact `title`; the CSS value is built first so an apostrophe can't break the quoting.
 * Scoped to message-scroller-item so it never matches the open chain row's duplicate title (#991). */
export function titleSelector(titleText) {
  const cssValue = titleText.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `Array.from(document.querySelectorAll(${JSON.stringify(`[title="${cssValue}"]`)})).find(el => el.closest('[data-slot="message-scroller-item"]'))`;
}

// `?.closest` because a missing row would otherwise throw, and `cdp.waitFor` rethrows instead of polling again.
export function stageContentSelector(titleText) {
  return `${titleSelector(titleText)}?.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')`;
}

export function stageTriggerSelector(titleText) {
  return `${titleSelector(titleText)}?.closest('[data-slot="collapsible-trigger"]')`;
}

/** Scrolls the target to viewport centre before clicking (cdp.click never scrolls); polls for existence first so a not-yet-rendered target isn't skipped. */
export async function clickScrolled(cdp, finderExpr, options) {
  await cdp.waitFor(`!!(${finderExpr})`, { timeoutMs: options?.timeoutMs ?? 15_000, label: `clickScrolled: waiting for ${finderExpr}` });
  await cdp.evaluate(`(() => { const el = ${finderExpr}; if (el) el.scrollIntoView({ block: 'center' }); })()`);
  await cdp.evaluate(`new Promise((resolve) => requestAnimationFrame(resolve))`);
  await cdp.click(finderExpr, options);
}

// Mirrors the finder construction in `verify-tauri-cdp.mjs`'s clickByLabel/clickByText so the scroll targets the element the real click resolves.
function labelFinderExpr(label, { inDialog = false, prefix = false } = {}) {
  const scope = inDialog ? `document.querySelector('[role="dialog"]')` : 'document.body';
  return prefix
    ? `(() => { const root = ${scope}; if (!root) return null; return Array.from(root.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(label)})); })()`
    : `(() => { const root = ${scope}; if (!root) return null; return root.querySelector('[aria-label=${JSON.stringify(label)}]'); })()`;
}

export async function clickByLabelScrolled(cdp, label, options) {
  await clickScrolled(cdp, labelFinderExpr(label, options), options);
}

function textFinderExpr(text, { inDialog = false, tag = 'button' } = {}) {
  const scope = inDialog ? `document.querySelector('[role="dialog"]')` : 'document.body';
  return `(() => { const root = ${scope}; if (!root) return null; return Array.from(root.querySelectorAll('${tag}')).find((el) => el.textContent.trim() === ${JSON.stringify(text)}); })()`;
}

export async function clickByTextScrolled(cdp, text, options) {
  await clickScrolled(cdp, textFinderExpr(text, options), options);
}

// Expand helpers live in `verify-941-stage-naming-expand-helpers.mjs` (#806 file-size cap) and are re-imported here.
async function assertExpandCycle(cdp, titleText, findings, failures, themeName, label, firstPassExpectedBefore) {
  await assertExpandCycleByFinder(cdp, stageTriggerSelector(titleText), findings, failures, themeName, label, firstPassExpectedBefore);
}

/** Naming: all ten Stages' visible labels; Stage 10 is otherwise only expanded by `assertNarrowViewportOverflow`, which doesn't re-check text. */
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
  // `nodes[0].name` is empty for a plain text span (Chromium names nested leaves), so use `axText`.
  for (const [label, titleText, rule] of expectations) {
    const name = await axText(cdp, titleSelector(titleText));
    if (name !== titleText) {
      failures.push(`[${themeName}] ${label}'s own visible label (AX name of its label span) was ${JSON.stringify(name)}, expected exactly ${JSON.stringify(titleText)} (${rule}).`);
    } else {
      findings.push(`[${themeName}] ${label} label exactly ${JSON.stringify(titleText)} (${rule}).`);
    }
  }
}

/** A solo Stage's label or `summary` slot contains the agent's name: Stage 9 as its whole label, Stage 6 in the always-mounted trigger's summary (no expand needed). */
export async function assertSoloAgentName(cdp, findings, failures, themeName, notExercised) {
  const noCtxText = await cdp.evaluate(`${stageTriggerSelector(STAGE9_SOLO_NOCTX_TITLE)}?.textContent ?? ''`);
  if (!noCtxText.includes('SoloBare')) {
    failures.push(`[${themeName}] Stage 9 (solo, no context)'s own trigger does not contain its sole agent's name "SoloBare" (got: ${JSON.stringify(noCtxText)}).`);
  } else {
    findings.push(`[${themeName}] Stage 9 (solo, no context)'s own visible label IS its sole agent's name "SoloBare" (computeStageLabel's own names.length === 1 fallback, gate round 2 item 1).`);
  }
  // The agent is "R8Solo"; "Story559" only appears in the context label, so checking the whole trigger text passed trivially.
  // Target the summary span by `title="R8Solo"` (set only when summaryFixedWidth) and assert text and width > 0 (zero-width regression).
  const summarySpan = await cdp.evaluate(`(() => {
    const el = ${stageTriggerSelector(STAGE6_SOLO_TITLE)}?.querySelector('[title="R8Solo"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { text: el.textContent, width: rect.width };
  })()`);
  if (!summarySpan || summarySpan.text !== 'R8Solo' || !(summarySpan.width > 0)) {
    failures.push(`[${themeName}] Stage 6 (solo, with context)'s own CollapsedLine summary slot (found by its own title="R8Solo") does not show its sole agent's real name "R8Solo" at a visible (>0px) width (got: ${JSON.stringify(summarySpan)}).`);
  } else {
    findings.push(`[${themeName}] Stage 6 (solo, with context)'s own CollapsedLine summary slot shows its sole agent's real name "R8Solo" (never "Story559", which is only Stage 6's own context-derived LABEL text) at a visible width of ${summarySpan.width}px (>0, the #941 gate-round-3 zero-width regression guard).`);
  }
  // The chat pane has a `minSize={360}` floor (`App.tsx`), so narrowing the window may not narrow the trigger: measure its real width
  // after two animation frames; a held floor is recorded in `notExercised`.
  const measureNarrowTrigger = () => cdp.evaluate(`(() => {
    const trigger = ${stageTriggerSelector(STAGE6_SOLO_TITLE)};
    if (!trigger) return null;
    const label = trigger.querySelector('[data-slot="collapsed-line-label"]');
    const summary = trigger.querySelector('[title="R8Solo"]');
    const svgs = trigger.querySelectorAll('svg');
    const chevron = svgs.length > 0 ? svgs[svgs.length - 1] : null;
    const triggerRect = trigger.getBoundingClientRect();
    const chevronRect = chevron ? chevron.getBoundingClientRect() : null;
    return {
      triggerWidth: triggerRect.width,
      labelWidth: label ? label.getBoundingClientRect().width : null,
      summaryWidth: summary ? summary.getBoundingClientRect().width : null,
      chevronWidth: chevronRect ? chevronRect.width : null,
      chevronHeight: chevronRect ? chevronRect.height : null,
      chevronClipped: chevronRect ? chevronRect.right > triggerRect.right + 1 || chevronRect.left < triggerRect.left - 1 : null
    };
  })()`);
  const waitTwoFrames = () => cdp.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const assertAtMeasuredWidth = (narrow, requestedWindowWidth) => {
    if (!narrow) {
      failures.push(`[${themeName}] Could not measure Stage 6's own trigger at a ${requestedWindowWidth}px window.`);
      return;
    }
    const w = Math.round(narrow.triggerWidth);
    if (!(narrow.labelWidth > 0)) {
      failures.push(`[${themeName}] At a ${requestedWindowWidth}px window (Stage 6's own trigger measured ${w}px wide), the label span has width ${narrow.labelWidth} (expected > 0px -- the label must never shrink all the way to 0px, P4's own regression).`);
    } else {
      findings.push(`[${themeName}] At a ${requestedWindowWidth}px window (trigger measured ${w}px wide), Stage 6 (solo)'s own label span keeps a visible width of ${narrow.labelWidth}px.`);
    }
    if (!(narrow.summaryWidth > 0)) {
      failures.push(`[${themeName}] At a ${requestedWindowWidth}px window (trigger measured ${w}px wide), Stage 6 (solo)'s own summary span ("R8Solo") has width ${narrow.summaryWidth} (expected > 0px).`);
    } else {
      findings.push(`[${themeName}] At a ${requestedWindowWidth}px window (trigger measured ${w}px wide), Stage 6 (solo)'s own summary span keeps a visible width of ${narrow.summaryWidth}px.`);
    }
    if (!(narrow.chevronWidth > 0) || !(narrow.chevronHeight > 0) || narrow.chevronClipped) {
      failures.push(`[${themeName}] At a ${requestedWindowWidth}px window (trigger measured ${w}px wide), Stage 6's own chevron icon is clipped or has zero size (${JSON.stringify(narrow)}).`);
    } else {
      findings.push(`[${themeName}] At a ${requestedWindowWidth}px window (trigger measured ${w}px wide), Stage 6's own chevron icon stays fully visible (${narrow.chevronWidth}x${narrow.chevronHeight}px, not clipped), fully inside the row.`);
    }
  };
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
    await waitTwoFrames();
    const narrow320 = await measureNarrowTrigger();
    assertAtMeasuredWidth(narrow320, 320);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 240, height: 800, deviceScaleFactor: 1, mobile: false });
    await waitTwoFrames();
    const narrow240 = await measureNarrowTrigger();
    if (narrow240 && narrow320 && narrow240.triggerWidth < narrow320.triggerWidth - 1) {
      findings.push(`[${themeName}] A 240px window genuinely narrows Stage 6's own trigger further (${Math.round(narrow240.triggerWidth)}px, was ${Math.round(narrow320.triggerWidth)}px at 320px) -- re-checked at this width.`);
      assertAtMeasuredWidth(narrow240, 240);
    } else {
      notExercised.push(
        `[${themeName}] A 240px-wide Stage 6 trigger was not reached (320px window measured ${narrow320 ? Math.round(narrow320.triggerWidth) : 'unknown'}px, 240px window measured ${narrow240 ? Math.round(narrow240.triggerWidth) : 'unknown'}px) -- the chat pane's own minSize={360} floor (App.tsx:527) appears to hold regardless of the requested window width.`
      );
    }
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
  }
}

/** A settled Stage's `meta` shows the exact "N done"/"N done, M failed" wording plus duration and "started <time>", read via `textContent`. Stages 1 and 5 cover both shapes. */
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

/** Every finished agent/Stage gets a green icon and label (`--severity-success`), including a member row in an expanded Stage at 4.5:1; Stage 5's FAILED agent must not be green. */
export async function assertGreenFinished(cdp, findings, failures, themeName) {
  const expectedColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
  // Stage 5's header is not green: `overallStatus` prioritises `failed`, so it is checked as a negative case below.
  const finishedRows = [
    ['Stage 1 header', STAGE1_TITLE],
    ['Stage 2 header', STAGE2_TITLE],
    ['Stage 3 header', STAGE3_TITLE],
    ['Stage 4 header', STAGE4_TITLE],
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

  // A member row inside an expanded multi-agent Stage (Stage 1's G923Code, title-unique).
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

  // Negative case: Stage 5's FailAgent and header are not green (a failed member makes the Stage `failed`).
  await expandRow(cdp, STAGE5_TITLE);
  const stage5HeaderStyles = await cdp.evaluate(`(() => {
    const span = ${titleSelector(STAGE5_TITLE)};
    if (!span) return null;
    const row = span.closest('[data-slot="collapsible-trigger"]') ?? span.parentElement;
    const icon = row?.querySelector('svg');
    return { labelColor: getComputedStyle(span).color, iconColor: icon ? getComputedStyle(icon).color : null };
  })()`);
  if (!stage5HeaderStyles) {
    failures.push(`[${themeName}] Could not measure Stage 5's own header computed colour.`);
  } else if (stage5HeaderStyles.labelColor === expectedColor || stage5HeaderStyles.iconColor === expectedColor) {
    failures.push(`[${themeName}] REGRESSION: Stage 5's own header (one failed member) is green (label ${stage5HeaderStyles.labelColor}, icon ${stage5HeaderStyles.iconColor}) -- a Stage with any failed member must never be green, only a fully finished Stage.`);
  } else {
    findings.push(`[${themeName}] Stage 5's own header (one failed member) stays NOT green, as issue #941 requires (only a fully finished Stage/agent is green).`);
  }
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

  // Regression guard: the plain non-Stage `read` tool row stays neutral.
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

/** Expanding Stage 1 reveals its batch context, and both members show their result's first line without further expansion. */
export async function assertDetailsOnExpand(cdp, findings, failures, themeName, isFirstThemePass) {
  // Stage 1 is deterministically open here (see `assertExpandCycleByFinder`).
  await assertExpandCycle(cdp, STAGE1_TITLE, findings, failures, themeName, 'Stage 1', isFirstThemePass ? 'true' : undefined);
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

/** With ten Stages the per-turn chain row renders (`stages.length >= 2`); its `ChainStageLine`s match the in-place rows.
 * Its expand click uses the `aria-expanded`-aware guard since an earlier theme pass may have expanded it. */
export async function assertChainRow(cdp, findings, failures, themeName, isFirstThemePass) {
  const chainTriggerFinder = `Array.from(document.querySelectorAll('[aria-label="Transcript"] [data-slot="collapsible-trigger"]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Subagents, '))`;
  const chainPresent = await cdp.evaluate(`!!(${chainTriggerFinder})`);
  if (!chainPresent) {
    failures.push(`[${themeName}] The per-turn "Subagents" chain row did not render despite this turn having 10 Stages (stages.length >= 2, FR-065).`);
    return;
  }
  findings.push(`[${themeName}] The per-turn "Subagents" chain row rendered (10 Stages in this turn).`);
  // On the first theme pass Stage 5's failed agent makes the whole chain row default OPEN (unlike a Stage row), so expect 'true'.
  await assertExpandCycleByFinder(cdp, chainTriggerFinder, findings, failures, themeName, 'The chain row', isFirstThemePass ? 'true' : undefined);
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
