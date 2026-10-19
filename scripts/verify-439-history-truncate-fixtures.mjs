// Pure-logic, behaviour-preserving extraction from `verify-439-history-truncate.mjs` (issue
// #1012 gate follow-up: the Escape-stacking fix pushed the main script to 604 lines, over the
// #806 600-line soft cap; gate round 1's real-Tab/focus-ring/tooltip-position checks pushed it
// over again). Fixture constants and small pure helpers shared by `main()`; no logic change,
// `node --check` clean on both files (same pattern as `scripts/verify-551-helpers.mjs`).

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pressTab } from './verify-tauri-session-list-helpers.mjs';

export const THEMES = [
  { id: 'dark', name: 'Dark', shot: '01-history-dark.png' },
  { id: 'obsidian', name: 'Obsidian', shot: '02-history-obsidian.png' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)', shot: '03-history-dark-high-contrast.png' }
];
export const SHOT_NAMES = ['00-focus-tooltip.png', ...THEMES.map((t) => t.shot), 'report.json', 'app.log', 'fake-omp-invocations.log'];

export const NORMAL_TITLE = 'Normal conversation (#439 check)';
export const NORMAL_PREVIEW = 'Short first message, fits comfortably inside the dialog.';
export const LONG_TITLE =
  'This deliberately very long Conversation title exists only to prove the history dialog truncates it to one line with an ellipsis instead of overflowing (issue #439)';
// Padded to EXACTLY 120 characters (`PREVIEW_MAX_LENGTH`, `conversations.rs`) so this is the
// widest preview the real app can ever produce, not an arbitrarily longer string.
const LONG_PREVIEW_PREFIX =
  'ISSUE439-LONG-PREVIEW-CHECK: first user message, deliberately sized to the full PREVIEW_MAX_LENGTH cap for the history-dialog truncation check ';
export const LONG_PREVIEW = (LONG_PREVIEW_PREFIX + '#'.repeat(120)).slice(0, 120);
export const PREVIEW_MAX_LENGTH = 120; // conversations.rs
// Issue #1012 item 5: one real prompt sent through the composer to settle a turn (reusing
// `user-message-time.jsonl`'s own already-scripted tool call -- AGENTS.md: no new fixtures), so
// `sync_from_state.rs`'s `if message_count > 0` guard marks the long Conversation current.
export const PROMPT_TEXT = 'Issue #1012 check: exercise the Current badge next to a long truncating title.';

// Issue #1012 item 5: scopes every dialog-presence/content read to the KNOWN Conversation
// history dialog specifically (its own `DialogTitle` text), never any element that merely has
// `role="dialog"` -- the post-theme-switch reopen wait used to accept any such element.
export const HISTORY_DIALOG_FINDER =
  `Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.querySelector('[data-slot="dialog-title"]')?.textContent.trim() === 'Conversation history')`;

/** Finder expression for one history row's own button by its exact title-span text, scoped to
 * the known history dialog (never any `[role="dialog"]`). Evaluates to `null` when the dialog
 * or the row is not present. */
export function rowButtonFinder(titleText) {
  return `(() => { const dialog = ${HISTORY_DIALOG_FINDER}; if (!dialog) return null; return Array.from(dialog.querySelectorAll('ul li button[data-choice-item]')).find((b) => (b.children[0]?.querySelector('span')?.textContent ?? '') === ${JSON.stringify(titleText)}) ?? null; })()`;
}

/** `conversations.rs`'s own `parse_file_name` doc comment: a file is named
 * `<timestamp with ':'/'.' replaced by '-'>_<id>.jsonl`, the timestamp prefix always exactly 25
 * characters (`YYYY-MM-DDTHH-mm-ss-mmmZ_`). */
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

/** Reads one Conversation history row's own structural truncation evidence: the title span
 * (inside `btn.children[0]`, alongside the Current badge) and the preview span
 * (`btn.children[2]`, only present when `conversation.preview` is non-empty). Returns `null` for
 * either span if the row does not have it (e.g. no preview). */
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

/** Real keyboard Tab presses (never a scripted `.focus()`, which does not reliably set
 * Chromium's `:focus-visible`) until `document.activeElement` is the row button matching
 * `titleText`, bounded to `maxPresses` so a DOM-order change fails loudly instead of hanging.
 * Returns whether the row was reached. */
export async function reachRowViaRealTab(cdp, titleText, maxPresses) {
  for (let i = 0; i < maxPresses; i++) {
    await pressTab(cdp);
    const reached = await cdp.evaluate(`document.activeElement === (${rowButtonFinder(titleText)})`);
    if (reached) return true;
  }
  return false;
}

/** Whether the row button matching `titleText` currently matches `:focus-visible`, and its
 * computed `box-shadow` (expected non-`"none"` when a focus-visible ring is actually
 * rendering). `null` if the row is not present. */
export async function readRowFocusStyle(cdp, titleText) {
  return cdp.evaluate(`(() => {
    const el = ${rowButtonFinder(titleText)};
    if (!el) return null;
    return { matchesFocusVisible: el.matches(':focus-visible'), boxShadow: getComputedStyle(el).boxShadow };
  })()`);
}

/** Geometry evidence for the row/Tooltip position check: the row's right edge, the open
 * Tooltip's left edge, and each of its `<p>` lines' own top/bottom (to confirm they stack
 * vertically rather than laying out side by side in `TooltipContent`'s default row direction).
 * `null` if the row or an open `[role="tooltip"]` is not present. */
export async function readTooltipPositionEvidence(cdp, titleText) {
  return cdp.evaluate(`(() => {
    const row = ${rowButtonFinder(titleText)};
    const tooltip = document.querySelector('[role="tooltip"]');
    if (!row || !tooltip) return null;
    const rowRect = row.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const lineRects = Array.from(tooltip.querySelectorAll('p')).map((p) => p.getBoundingClientRect());
    return {
      rowRight: rowRect.right,
      tooltipLeft: tooltipRect.left,
      lineTops: lineRects.map((r) => r.top),
      lineBottoms: lineRects.map((r) => r.bottom)
    };
  })()`);
}

/** Dialog-level: no horizontal overflow at the current theme. `findings`/`failures` are the
 * caller's own arrays (mutated in place, same pattern `main()` itself used before this
 * extraction). */
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

/** Row-level: ellipsis CSS in effect, long row genuinely clips, title attribute carries the
 * full text, normal row does NOT need to clip (control case), Current badge beside the long
 * row -- re-run in every theme (issue #1012 item 5: geometry is no longer assumed constant
 * across themes). */
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
    if (longEvidence.title && longEvidence.title.title !== LONG_TITLE) {
      failures.push(`[${themeName}] Long row title's own title attribute is ${JSON.stringify(longEvidence.title.title)}, expected the full title ${JSON.stringify(LONG_TITLE)} -- the full text must stay available even when visually clipped.`);
    } else if (longEvidence.title) {
      findings.push(`[${themeName}] Long row title's own title attribute carries the full, un-truncated title text.`);
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
    if (longEvidence.preview && longEvidence.preview.title !== LONG_PREVIEW) {
      failures.push(`[${themeName}] Long row preview's own title attribute is ${JSON.stringify(longEvidence.preview.title)}, expected the full preview ${JSON.stringify(LONG_PREVIEW)}.`);
    } else if (longEvidence.preview) {
      findings.push(`[${themeName}] Long row preview's own title attribute carries the full, un-truncated 120-character preview text.`);
    }
  }
}
