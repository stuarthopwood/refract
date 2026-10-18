// Shared driving/assertion helpers for `scripts/verify-941-stage-naming.mjs` (issue #941: Stage
// naming, the one green exception for a finished Subagent/Stage, the Stage's own batch context on
// expansion, real "Uses:" dependencies, the per-turn Subagent chain row, and the now-UNIFIED
// solo-vs-multi-agent Stage header), split out to stay under the #806 600-line file-size cap.
//
// Gate round 1: EVERY Stage (solo or not) gets the same header via `stageHeading()`
// (`./stageMeta.ts`), a muted roll-up ("N done"/"N done, M failed") plus a muted duration AND
// start time, all inside `meta`; expanded content order is `StageContextBrief` (only when
// `group.context` is set), then `StageUsesLine`, then either `SubagentBody` (solo) or a
// `SpineList` of `SubagentRow`s (multi). Gate round 2 (items 9-12): the `aria-expanded`-aware
// expand-cycle guard every Stage/chain row below uses (`switchTheme` never reloads the app, so
// a prior theme pass's own expand survives into the next); Stage 8's `sharedNamePrefix`
// fallback and `assertStageMetaRollup`'s exact counts/duration/start-time check; Stage 9 (solo,
// no context) and Stage 10 (borderline-length, `assertNarrowViewportOverflow` proves
// `ResizeObserver` genuinely re-measures on a real narrow-viewport change).
//
// Selector strategy unchanged: `CollapsedLine.tsx` sets a plain `title` attribute on a Stage/
// member row's own visible label SPAN whenever that label is a literal string -- a real,
// source-grounded way to find one exact row without guessing at the FULL accessible name
// (`triggerAriaLabel`). The Naming assertion reads the label SPAN's own name via `axText`
// (walks direct AX children, not `nodes[0].name` -- empty on a bare span, gate-fix above);
// every other assertion wanting visible, non-AX text (meta rollup, solo summary, Uses: lines)
// reads `textContent` instead, since `meta`/`summary` render inside the mounted trigger.
//
// `SubagentPanel.tsx` now keys its own tree rows by a `toolCallId:specIndex` composite (gate
// round 3/4), disambiguating two same-named agents -- see `verify-941-stage-naming-panel-helpers.mjs`'s own header.
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

/** A local copy of `verify-tauri-scratch-helpers.mjs`'s own `launchBuiltExe`, with
 * `pathPrepend`/`extraEnv` restored (the fake-omp PATH shim and FAKE_OMP env vars only this
 * fixture-driven check needs). Live-build fix (first real build-slot run; prior gate rounds
 * were code-verified only): `REFRACT_CDP_PORT` is not an env var the Rust app reads anywhere
 * (grep-confirmed) -- swapped for the real, proven `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`/
 * `WEBVIEW2_USER_DATA_FOLDER` pair the scratch-helpers version already uses.
 * `launchViaJobObject` also gained an explicit `pidFile` 2nd positional argument since this
 * was written; the old 3-arg call mis-mapped `[exePath]` onto it and spread `undefined` as
 * `targetArgs`, throwing "targetArgs is not iterable". */
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

/** Live-build fix (first real build-slot run, never exercised before): the old version wrapped
 * the JSON-stringified attribute value inside an OUTER single-quoted JS string -- an apostrophe
 * anywhere in `titleText` closed that string early, a syntax error the instant this title was
 * ever actually waited on. Fixed by building the CSS value first, then `JSON.stringify`-ing the WHOLE `querySelector` argument once. Issue #991 follow-up 3: scoped to `[data-slot="message-scroller-item"]` (research.md decision 19) so this never matches the open chain row's own duplicate title (`ChainStageLine`). */
export function titleSelector(titleText) {
  const cssValue = titleText.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `Array.from(document.querySelectorAll(${JSON.stringify(`[title="${cssValue}"]`)})).find(el => el.closest('[data-slot="message-scroller-item"]'))`;
}

// Gate round 1 fix (issue #991, HIGH): a bare `.closest(...)` right after `titleSelector`'s own
// `.find(...)` threw when the row did not exist yet (`cdp.waitFor` rethrows a real error instead of polling again) -- `?.closest(...)` below.
export function stageContentSelector(titleText) {
  return `${titleSelector(titleText)}?.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]')`;
}

export function stageTriggerSelector(titleText) {
  return `${titleSelector(titleText)}?.closest('[data-slot="collapsible-trigger"]')`;
}

/** Gate round 5 fix (item 9, MEDIUM): `verify-tauri-cdp.mjs`'s own `click()` never scrolls its
 * target into view before computing the click coordinate -- scoped to these 941 scripts only
 * (not the shared helper itself, which other already-passing live-check scripts also call
 * unmodified): scrolls the resolved target to the viewport's own centre and waits one frame
 * before delegating to the real click. Gate round 6 fix (item 3, LOW): `cdp.waitFor` now polls
 * for the target's own existence FIRST -- a target that did not exist yet (still rendering, a
 * dialog still opening) used to no-op the scroll silently, with only the later `cdp.click`'s
 * own internal polling ever finding it, by which point no scroll had happened. */
export async function clickScrolled(cdp, finderExpr, options) {
  await cdp.waitFor(`!!(${finderExpr})`, { timeoutMs: options?.timeoutMs ?? 15_000, label: `clickScrolled: waiting for ${finderExpr}` });
  await cdp.evaluate(`(() => { const el = ${finderExpr}; if (el) el.scrollIntoView({ block: 'center' }); })()`);
  await cdp.evaluate(`new Promise((resolve) => requestAnimationFrame(resolve))`);
  await cdp.click(finderExpr, options);
}

// Mirrors `verify-tauri-cdp.mjs`'s own `clickByLabel`/`clickByText` finder construction exactly
// (grep-verified), so `clickByLabelScrolled`/`clickByTextScrolled` scroll the SAME element the
// real click then resolves, never a near-miss built from drifted selector logic.
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

// `expandByFinder`/`expandRow`/`assertExpandCycleByFinder` moved to
// `verify-941-stage-naming-expand-helpers.mjs` (issue #991 final-delta gate, #806 file-size
// discipline); re-imported below since `assertGreenFinished`/`assertDetailsOnExpand`/
// `assertChainRow` in this same file still call them.
async function assertExpandCycle(cdp, titleText, findings, failures, themeName, label, firstPassExpectedBefore) {
  await assertExpandCycleByFinder(cdp, stageTriggerSelector(titleText), findings, failures, themeName, label, firstPassExpectedBefore);
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
  // Gate-fix (first real build-slot run, never exercised before): `getAccessibleNameAndRole`'s
  // `nodes[0].name` is reliable for a WIDGET but comes back EMPTY for this plain text-content
  // span -- Chromium computes "name" on nested leaves under the node, not the node itself
  // (confirmed live: all ten Stages came back `""`; `verify-tauri-560-helpers.mjs`'s own
  // `axText` already fixed this against a different span, promoted here to the shared helpers).
  for (const [label, titleText, rule] of expectations) {
    const name = await axText(cdp, titleSelector(titleText));
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
export async function assertSoloAgentName(cdp, findings, failures, themeName, notExercised) {
  const noCtxText = await cdp.evaluate(`${stageTriggerSelector(STAGE9_SOLO_NOCTX_TITLE)}?.textContent ?? ''`);
  if (!noCtxText.includes('SoloBare')) {
    failures.push(`[${themeName}] Stage 9 (solo, no context)'s own trigger does not contain its sole agent's name "SoloBare" (got: ${JSON.stringify(noCtxText)}).`);
  } else {
    findings.push(`[${themeName}] Stage 9 (solo, no context)'s own visible label IS its sole agent's name "SoloBare" (computeStageLabel's own names.length === 1 fallback, gate round 2 item 1).`);
  }
  // Gate round 3 fix (item 10): the real agent `task()` named for Stage 6 is "R8Solo" (fixture
  // `stage6-task`), not "Story559" -- that only appears in Stage 6's own CONTEXT text, already
  // asserted by `assertStageNaming` as the Stage's own LABEL. The old `includes('Story559')`
  // check against the WHOLE trigger's `textContent` was trivially true via the label alone and
  // never exercised `CollapsedLine`'s own `summary` slot (nor the #941 gate-round-3 zero-width
  // regression: a solo Stage's summary rendering at 0px once label/meta filled the available
  // width). This targets that SPAN specifically, by its own `title="R8Solo"` (set only when
  // `summaryFixedWidth` is true, i.e. a solo Stage WITH context), asserting text AND width > 0.
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
  // Gate round 4/5 fix: the chat pane has its own `minSize={360}` floor (`App.tsx:527`) --
  // narrowing the WINDOW does NOT mean the Stage trigger itself ever reaches that width; the
  // previous version asserted against the REQUESTED window width instead of the trigger's own
  // real rendered width. Waits two animation frames for layout to settle after each resize,
  // then measures the trigger's own ACTUAL width; a 240px window not genuinely narrowing the
  // trigger further (the floor holding) is recorded honestly in `notExercised` instead.
  const measureNarrowTrigger = () => cdp.evaluate(`(() => {
    const trigger = ${stageTriggerSelector(STAGE6_SOLO_TITLE)};
    if (!trigger) return null;
    const label = trigger.querySelector('span.font-medium');
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

/** Issue #941 grill item 3 (gate round 2 fix, item 11b): a settled Stage's own `meta` slot shows
 * the exact "N done"/"N done, M failed" counts wording TOGETHER WITH a rendered duration AND a
 * "started <time>" text, all inside the same `CollapsibleTrigger` (`SubagentChainRow.tsx`'s own
 * `joinMetaParts` build) -- read via `textContent`, since `meta` renders visibly there, not only
 * in `triggerAriaLabel`. Stage 1 (all finished) and Stage 5 (one finished, one failed) cover
 * both wording shapes. */
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
 * (`statusGlyph.ts`'s `success-done` key, `subagentStatus.tsx`'s `SUBAGENT_SUCCESS_TEXT_CLASS`),
 * measured against the theme's own resolved `--severity-success`. Also measures a MEMBER row
 * INSIDE an expanded multi-agent Stage at a measured 4.5:1 contrast ratio; confirms Stage 5's
 * own FAILED agent (`FailAgent`) is NOT green. */
export async function assertGreenFinished(cdp, findings, failures, themeName) {
  const expectedColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
  // Gate-fix (first real build-slot run): Stage 5's own HEADER was wrongly listed here as
  // expected-green -- `overallStatus` prioritises `failed` over `finished`, so a Stage with one
  // FAILED agent is STAGE-LEVEL status `'failed'` and is correctly NOT green (confirmed live).
  // Moved to a real negative check next to the FailAgent one below instead.
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

  // Negative case (fixture item c): Stage 5's own FailAgent is NOT green, and neither is Stage
  // 5's own HEADER (a Stage's overall status prioritises `failed` over `finished`, so a Stage
  // with any failed member is never itself green, same as the member).
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
 * `ToolRow.tsx`'s `SubagentRow`, `extractResultSummary`): expanding Stage 1 reveals its own
 * batch context; BOTH members show their result's first line with no need to expand further. */
export async function assertDetailsOnExpand(cdp, findings, failures, themeName, isFirstThemePass) {
  // Issue #991 final-delta fix: Stage 1 is deterministically open here now (see `assertExpandCycleByFinder`'s own doc comment).
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

/** Issue #941 grill item 5/decision 6: with ten Stages the per-turn "Subagents" chain row
 * renders (`SubagentChainRow.tsx`, `stages.length >= 2`), and its own compact `ChainStageLine`
 * entries show each Stage's label (speech form) and green finished agent names, matching the
 * in-place rows. Gate round 2 fix (item 9): the chain row's own expand click now goes through
 * the same `aria-expanded`-aware guard every Stage row uses, since a prior theme pass in this
 * same run may have already expanded it. */
export async function assertChainRow(cdp, findings, failures, themeName, isFirstThemePass) {
  const chainTriggerFinder = `Array.from(document.querySelectorAll('[aria-label="Transcript"] [data-slot="collapsible-trigger"]')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Subagents, '))`;
  const chainPresent = await cdp.evaluate(`!!(${chainTriggerFinder})`);
  if (!chainPresent) {
    failures.push(`[${themeName}] The per-turn "Subagents" chain row did not render despite this turn having 10 Stages (stages.length >= 2, FR-065).`);
    return;
  }
  findings.push(`[${themeName}] The per-turn "Subagents" chain row rendered (10 Stages in this turn).`);
  // Gate round 3 fix (item 11): on the FIRST theme pass, this fixture's own data makes the
  // starting value unambiguous -- Stage 5 carries one `failed` agent, so `counts.failed > 0`
  // makes the WHOLE TURN's chain row default OPEN (`SubagentChainRow.tsx:429`), the opposite
  // of a Stage row's own default-closed state; asserted as `'true'`, never `'false'`.
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
