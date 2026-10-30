// Shared helpers for `verify-439-history-truncate.mjs`: fixtures, DOM finders, CDP readers and per-theme assertions.
// Split out to keep the main script under the 600-line cap (#806).

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pressTab } from './verify-tauri-session-list-helpers.mjs';
import { sleep } from './verify-tauri-cdp.mjs';

export const THEMES = [
  { id: 'dark', name: 'Dark', shot: '01-history-dark.png' },
  { id: 'obsidian', name: 'Obsidian', shot: '02-history-obsidian.png' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)', shot: '03-history-dark-high-contrast.png' }
];
export const SHOT_NAMES = [
  '00-focus-tooltip.png',
  '00b-narrow-window-tooltip.png',
  ...THEMES.map((t) => t.shot),
  'report.json',
  'app.log',
  'fake-omp-invocations.log'
];

export const NORMAL_TITLE = 'Normal conversation (#439 check)';
export const NORMAL_PREVIEW = 'Short first message, fits comfortably inside the dialog.';
export const LONG_TITLE =
  'This deliberately very long Conversation title exists only to prove the history dialog truncates it to one line with an ellipsis instead of overflowing (issue #439)';
// Exactly 120 chars (`PREVIEW_MAX_LENGTH`, conversations.rs): the widest preview the app can produce.
const LONG_PREVIEW_PREFIX =
  'ISSUE439-LONG-PREVIEW-CHECK: first user message, deliberately sized to the full PREVIEW_MAX_LENGTH cap for the history-dialog truncation check ';
export const LONG_PREVIEW = (LONG_PREVIEW_PREFIX + '#'.repeat(120)).slice(0, 120);
export const PREVIEW_MAX_LENGTH = 120; // conversations.rs
// Settles a turn through the composer so `sync_from_state.rs`'s `message_count > 0` guard marks the long Conversation current.
export const PROMPT_TEXT = 'Issue #1012 check: exercise the Current badge next to a long truncating title.';

// Scoped to the Conversation history dialog by title, never any `role="dialog"` element.
export const HISTORY_DIALOG_FINDER =
  `Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.querySelector('[data-slot="dialog-title"]')?.textContent.trim() === 'Conversation history')`;

/** Finder for one history row's button by exact title text; `null` when the dialog or row is absent. */
export function rowButtonFinder(titleText) {
  return `(() => { const dialog = ${HISTORY_DIALOG_FINDER}; if (!dialog) return null; return Array.from(dialog.querySelectorAll('ul li button[data-choice-item]')).find((b) => (b.children[0]?.querySelector('span')?.textContent ?? '') === ${JSON.stringify(titleText)}) ?? null; })()`;
}

/** Mirrors `parse_file_name` in conversations.rs: `<timestamp with ':'/'.' as '-'>_<id>.jsonl`, 25-char timestamp prefix. */
export function conversationFileName(isoTimestamp, id) {
  const prefix = isoTimestamp.replace(/[:.]/g, '-');
  if (prefix.length !== 24) throw new Error(`conversationFileName: expected a 24-char dash-replaced prefix, got ${prefix.length} ("${prefix}")`);
  return `${prefix}_${id}.jsonl`;
}

export function writeConversationFile(dir, isoTimestamp, id, lines) {
  const filePath = path.join(dir, conversationFileName(isoTimestamp, id));
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return filePath;
}

/** Reads a row's title span and preview span (`btn.children[2]`); either is `null` when absent. */
export async function readRowTruncationEvidence(cdp, titleText) {
  return cdp.evaluate(`(() => {
    const btn = ${rowButtonFinder(titleText)};
    if (!btn) return null;
    const describe = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        textContent: el.textContent,
        title: el.getAttribute('title'),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowsVisually: el.scrollWidth > el.clientWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace
      };
    };
    const titleSpan = btn.children[0]?.querySelector('span') ?? null;
    const previewSpan = btn.children[2] ?? null;
    return {
      hasCurrentBadge: !!btn.querySelector('[data-slot="badge"]'),
      title: describe(titleSpan),
      preview: previewSpan ? describe(previewSpan) : null
    };
  })()`);
}

/** Real Tab presses until the row is focused (a scripted `.focus()` does not reliably set `:focus-visible`); bounded so a DOM-order change fails loudly. */
export async function reachRowViaRealTab(cdp, titleText, maxPresses) {
  for (let i = 0; i < maxPresses; i++) {
    await pressTab(cdp);
    const reached = await cdp.evaluate(`document.activeElement === (${rowButtonFinder(titleText)})`);
    if (reached) return true;
  }
  return false;
}

/** Whether the row matches `:focus-visible` and its computed `box-shadow`; `null` if the row is absent. */
export async function readRowFocusStyle(cdp, titleText) {
  return cdp.evaluate(`(() => {
    const el = ${rowButtonFinder(titleText)};
    if (!el) return null;
    return { matchesFocusVisible: el.matches(':focus-visible'), boxShadow: getComputedStyle(el).boxShadow };
  })()`);
}

/** Finder for the known Tooltip (text includes `titleText`, or open `data-state`), never a bare `[role="tooltip"]` that could match another one. */
export function tooltipFinder(titleText) {
  return `Array.from(document.querySelectorAll('[role="tooltip"]')).find((t) => t.textContent.includes(${JSON.stringify(titleText)}) || t.getAttribute('data-state') === 'delayed-open' || t.getAttribute('data-state') === 'instant-open')`;
}

/** Waits for the Tooltip's animations to finish; a mid-transition rect read could pass or fail a position check by accident. */
export async function waitForTooltipAnimationsSettled(cdp, titleText) {
  await cdp.waitFor(`(() => { const t = ${tooltipFinder(titleText)}; return !!t && t.getAnimations().length === 0; })()`, {
    timeoutMs: 3_000,
    label: 'Tooltip animations settled'
  });
}

/** Row/Tooltip geometry: row right edge, Tooltip left/right edges, and each `<p>` line's top/bottom (to confirm vertical stacking); `null` if either is absent. */
export async function readTooltipPositionEvidence(cdp, titleText) {
  return cdp.evaluate(`(() => {
    const row = ${rowButtonFinder(titleText)};
    const tooltip = ${tooltipFinder(titleText)};
    if (!row || !tooltip) return null;
    const rowRect = row.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const lineRects = Array.from(tooltip.querySelectorAll('p')).map((p) => p.getBoundingClientRect());
    return {
      rowRight: rowRect.right,
      tooltipLeft: tooltipRect.left,
      tooltipRight: tooltipRect.right,
      lineTops: lineRects.map((r) => r.top),
      lineBottoms: lineRects.map((r) => r.bottom)
    };
  })()`);
}

/** Overrides the viewport via CDP device-metrics emulation, so a narrow pass needs no native window resize. */
export async function setWindowWidth(cdp, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}


/** Dialog-level: no horizontal overflow at the current theme. `findings`/`failures` are mutated in place. */
export async function assertDialogNeverScrollsHorizontally(cdp, findings, failures, themeName) {
  const dialogGeometry = await cdp.evaluate(`(() => {
    const dialog = ${HISTORY_DIALOG_FINDER};
    return dialog ? { scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth } : null;
  })()`);
  if (!dialogGeometry) {
    failures.push(`[${themeName}] Conversation history dialog not found when measuring horizontal overflow.`);
    return;
  }
  if (dialogGeometry.scrollWidth > dialogGeometry.clientWidth) {
    failures.push(
      `[${themeName}] Conversation history dialog has horizontal overflow: scrollWidth ${dialogGeometry.scrollWidth} > clientWidth ${dialogGeometry.clientWidth}.`
    );
  } else {
    findings.push(`[${themeName}] Conversation history dialog has no horizontal overflow (scrollWidth ${dialogGeometry.scrollWidth} <= clientWidth ${dialogGeometry.clientWidth}).`);
  }
}

export function assertTruncateCss(findings, failures, label, span) {
  if (!span) {
    failures.push(`${label}: span not found.`);
    return;
  }
  if (span.overflow !== 'hidden' || span.textOverflow !== 'ellipsis' || span.whiteSpace !== 'nowrap') {
    failures.push(`${label}: truncate CSS not fully in effect (overflow=${span.overflow}, textOverflow=${span.textOverflow}, whiteSpace=${span.whiteSpace}).`);
  } else {
    findings.push(`${label}: single-line with text-overflow:ellipsis active (overflow:hidden, white-space:nowrap).`);
  }
}

/** Row-level: ellipsis CSS, long row clips, title attribute carries full text, normal row does not clip, Current badge beside the long row. Re-run per theme (#1012). */
export async function assertRowTruncation(cdp, findings, failures, themeName) {
  const normalEvidence = await readRowTruncationEvidence(cdp, NORMAL_TITLE);
  const longEvidence = await readRowTruncationEvidence(cdp, LONG_TITLE);

  if (!normalEvidence) {
    failures.push(`[${themeName}] Normal Conversation row not found.`);
  } else {
    assertTruncateCss(findings, failures, `[${themeName}] Normal row title`, normalEvidence.title);
    if (normalEvidence.title && normalEvidence.title.overflowsVisually) {
      failures.push(`[${themeName}] Normal row title unexpectedly overflows visually (scrollWidth ${normalEvidence.title.scrollWidth} > clientWidth ${normalEvidence.title.clientWidth}) -- the control case should fit without clipping.`);
    }
    if (normalEvidence.title && normalEvidence.title.textContent !== NORMAL_TITLE) {
      failures.push(`[${themeName}] Normal row title text content is "${normalEvidence.title.textContent}", expected "${NORMAL_TITLE}".`);
    }
    assertTruncateCss(findings, failures, `[${themeName}] Normal row preview`, normalEvidence.preview);
    if (normalEvidence.preview && normalEvidence.preview.overflowsVisually) {
      failures.push(`[${themeName}] Normal row preview unexpectedly overflows visually (scrollWidth ${normalEvidence.preview.scrollWidth} > clientWidth ${normalEvidence.preview.clientWidth}) -- the control case should fit without clipping.`);
    }
    if (normalEvidence.hasCurrentBadge) {
      failures.push(`[${themeName}] Normal row unexpectedly shows the Current badge (expected only the long row to be current).`);
    }
    findings.push(`[${themeName}] Normal (short) row: both title and preview fit without visual overflow (control case).`);
  }

  if (!longEvidence) {
    failures.push(`[${themeName}] Long Conversation row not found.`);
  } else {
    assertTruncateCss(findings, failures, `[${themeName}] Long row title`, longEvidence.title);
    if (longEvidence.title && !longEvidence.title.overflowsVisually) {
      failures.push(`[${themeName}] Long row title does not overflow visually (scrollWidth ${longEvidence.title.scrollWidth} <= clientWidth ${longEvidence.title.clientWidth}) -- the long title fixture did not actually need to clip.`);
    } else if (longEvidence.title) {
      findings.push(`[${themeName}] Long row title genuinely clips visually (scrollWidth ${longEvidence.title.scrollWidth} > clientWidth ${longEvidence.title.clientWidth}), proving the ellipsis is actually doing work, not just styled.`);
    }
    if (longEvidence.title && longEvidence.title.title !== null) {
      failures.push(`[${themeName}] Long row title's own native title attribute is ${JSON.stringify(longEvidence.title.title)}, expected null -- issue #1012 item 3/gate round 2 removed it (redundant now the focus-visible Tooltip carries the full text, checked separately below); a value here means it leaked back in.`);
    } else if (longEvidence.title) {
      findings.push(`[${themeName}] Long row title has no native title attribute (removed, issue #1012 item 3/gate round 2 -- WCAG 1.4.13); the full, un-truncated text is proven available instead via the keyboard-focus Tooltip check below.`);
    }
    if (!longEvidence.hasCurrentBadge) {
      failures.push(`[${themeName}] Long row does not show the Current badge beside the truncating long title -- expected once Session.current_conversation is set.`);
    } else {
      findings.push(`[${themeName}] Long row shows the Current badge beside the truncating long title, the exact combination the issue's design notes call out.`);
    }

    assertTruncateCss(findings, failures, `[${themeName}] Long row preview`, longEvidence.preview);
    if (longEvidence.preview && !longEvidence.preview.overflowsVisually) {
      failures.push(`[${themeName}] Long row preview does not overflow visually (scrollWidth ${longEvidence.preview.scrollWidth} <= clientWidth ${longEvidence.preview.clientWidth}) -- the 120-char preview fixture did not actually need to clip.`);
    } else if (longEvidence.preview) {
      findings.push(`[${themeName}] Long row preview (exactly ${PREVIEW_MAX_LENGTH} characters, PREVIEW_MAX_LENGTH) genuinely clips visually (scrollWidth ${longEvidence.preview.scrollWidth} > clientWidth ${longEvidence.preview.clientWidth}).`);
    }
    if (longEvidence.preview && longEvidence.preview.title !== null) {
      failures.push(`[${themeName}] Long row preview's own native title attribute is ${JSON.stringify(longEvidence.preview.title)}, expected null -- issue #1012 item 3/gate round 2 removed it.`);
    } else if (longEvidence.preview) {
      findings.push(`[${themeName}] Long row preview has no native title attribute (removed, issue #1012 item 3/gate round 2); the full, un-truncated text is proven available instead via the keyboard-focus Tooltip check below.`);
    }
  }
}
