// Pure-logic, behaviour-preserving extraction from `verify-439-history-truncate.mjs` (issue
// #1012 gate follow-up: the Escape-stacking fix pushed the main script to 604 lines, over the
// #806 600-line soft cap). Fixture constants and small pure helpers shared by `main()`; no logic
// change, `node --check` clean on both files (same pattern as `scripts/verify-551-helpers.mjs`).

import { writeFileSync } from 'node:fs';
import path from 'node:path';

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
