// Shared helpers for `scripts/verify-925-924-polish.mjs` (issue #925 diff-stat colouring across
// four surfaces, issue #924 reasoning gauge needle, issue #919 per-file header): split out from
// the start (#806 file-size ratchet -- the main script already needs every one of
// `verify-tauri-scratch-helpers.mjs`'s own exports plus a real GitHub PR flow plus a reasoning-
// level picker drive plus a gauge-needle reader, which would not fit the 600-line cap alone).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

// Issue #925: `makeScratchRepo` (the shared helper every other `verify-5xx-*.mjs` script reuses)
// commits an EMPTY initial tree -- nothing to edit for a real, non-zero diffStat. This variant
// commits one tracked, multi-line file instead, so the main script can later edit it (inside the
// Session's own worktree, once Refract creates one) to produce a genuine `+A -D` diffStat rather
// than only ever exercising the "0 files changed +0 -0" muted case a fresh worktree already shows
// for free.
export const TRACKED_FILE_NAME = 'notes.md';
export const TRACKED_FILE_INITIAL_LINES = ['# Scratch notes', '', 'line one', 'line two', 'line three', 'line four', ''];

export function makeScratchRepoWithTrackedFile(dir, label) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepoWithTrackedFile: git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, TRACKED_FILE_NAME), TRACKED_FILE_INITIAL_LINES.join('\n'));
  run(['add', TRACKED_FILE_NAME]);
  run(['-c', `user.name=${label}`, '-c', `user.email=${label}@example.invalid`, 'commit', '-q', '-m', 'init']);
  return dir;
}

/** Issue #925: edits the tracked file INSIDE a Session's own worktree (not the scratch repo's
 * own origin checkout, a different directory once Refract creates the worktree) to produce a
 * real, non-zero, uncommitted diffStat -- appends 3 new lines (a genuine addition) and removes
 * one existing line (a genuine deletion), so the resulting `+3 -1` exercises BOTH the green and
 * the red branch of `DiffStatCounts` in one edit, not just one or the other.
 *
 * Gate round 1 fix (H1): on Windows, `git worktree add` checks the file out through
 * `core.autocrlf=true` (the system default, confirmed), so the worktree's own copy of this file
 * is CRLF, not the LF the scratch repo's own commit holds -- splitting on a bare `\n` left a
 * trailing `\r` on every line, so `'line one\r' !== 'line one'` and the filter below silently
 * removed nothing; every run measured a real `+4 -0`, never a genuine deletion, so the red
 * branch was never actually exercised despite the PASS. Splits on `\r?\n` to normalise BOTH line
 * endings before comparing, then rejoins with the file's OWN original EOL style (preserving it
 * for every untouched line, so git diff shows exactly the one real removal and three real
 * additions this function intends -- rejoining with a different EOL would make every surviving
 * line look both removed and re-added). */
export function editTrackedFileForDiff(worktreePath) {
  const filePath = path.join(worktreePath, TRACKED_FILE_NAME);
  const raw = readFileSync(filePath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const withoutOne = lines.filter((line) => line !== 'line one');
  const edited = [...withoutOne, 'line five', 'line six', 'line seven', ''];
  writeFileSync(filePath, edited.join(eol));
}

// Issue #924: the SAME 7-step angle formula `ReasoningGaugeIcon.tsx` computes, reimplemented
// here in plain JS so the script can derive the EXPECTED angle for whatever level the real UI
// settles on (including an `inherit` request OMP may resolve to any real level, or report back
// as `null`/`'inherit'` literally) and compare it against the ACTUAL angle read off the rendered
// SVG -- a self-consistent check that never hardcodes per-level expectations that could silently
// drift from the component's own source.
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ARC_START_DEG = 150;
const ARC_SWEEP_DEG = 240;
const MEDIUM_INDEX = LEVELS.indexOf('medium');

export function needleAngleDeg(level) {
  const index = level ? LEVELS.indexOf(level) : -1;
  const stepIndex = index === -1 ? MEDIUM_INDEX : index;
  return ARC_START_DEG + (stepIndex * ARC_SWEEP_DEG) / (LEVELS.length - 1);
}

/** Reads the rendered `ReasoningGaugeIcon`'s own needle `<path>` (`M12 14L{x} {y}`, the first of
 * its two `<path>` children -- the second is the static arc) off the live DOM and derives the
 * needle's actual angle in degrees via `atan2`, in the SAME bearing system (0deg = right, 90deg
 * = down, matching SVG's y-down coordinate space) `needleAngleDeg` above uses -- never trusting
 * a screenshot or a guessed geometry. `null` if the icon or its needle path is not found. */
export async function readGaugeNeedleAngle(cdp, svgFinderExpr) {
  return cdp.evaluate(`(() => {
    const svg = ${svgFinderExpr};
    if (!svg) return null;
    const needlePath = svg.querySelector('path');
    if (!needlePath) return null;
    const d = needlePath.getAttribute('d') || '';
    const match = d.match(/^M12 14L([\\-\\d.]+) ([\\-\\d.]+)$/);
    if (!match) return null;
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    return (Math.atan2(y - 14, x - 12) * 180) / Math.PI;
  })()`);
}

/** Issue #925: reads a `DiffStatCounts`-rendered pair of spans (the first containing `+N`, the
 * second `-N`) under the element `containerExpr` resolves to -- their own text, class list
 * (asserting the EXACT colour class the zero/positive rule picks, not merely a plausible colour)
 * and computed `color`, plus the nearest real rendered background behind them (walking up
 * `parentElement` for the first non-transparent `background-color`, the same technique the real
 * browser cascade uses -- #927's own composer box made `--composer-background` transparent in
 * two of three themes specifically so the chat background paints through, so a naive "read this
 * one ancestor's background" guess would silently measure the wrong backdrop in those themes).
 * `null` if the container or its own `.tabular-nums` counts wrapper is not found. */
export async function readDiffStatSpans(cdp, containerExpr) {
  return cdp.evaluate(`(() => {
    const container = ${containerExpr};
    if (!container) return null;
    const counts = container.querySelector('.tabular-nums');
    if (!counts) return null;
    // Gate round 1 fix: the counts wrapper may ALSO hold an sr-only accessible-label span
    // (\`DiffStatCounts\`'s own \`accessibleLabel\` prop) -- filtered out here so this always
    // resolves to exactly the two VISIBLE +N/-N spans, whether or not that prop is set.
    const spans = Array.from(counts.querySelectorAll(':scope > span')).filter((span) => !span.className.includes('sr-only'));
    if (spans.length !== 2) return null;
    function effectiveBackground(el) {
      let node = el;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        const match = bg.match(/^rgba?\\(\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*(?:,\\s*([\\d.]+)\\s*)?\\)$/);
        // Gate round 1 fix (L4): a PARTIALLY transparent background (alpha strictly between 0
        // and 1) is not the real opaque backdrop either -- the true rendered colour still
        // depends on whatever is further beneath it. Only alpha === 1 (an explicit '1', or no
        // alpha channel at all, which rgba()/getComputedStyle always report as fully opaque)
        // counts as "found"; anything else keeps walking up.
        const alpha = match && match[1] !== undefined ? parseFloat(match[1]) : 1;
        if (match && alpha === 1) return bg;
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    }
    return {
      added: { text: spans[0].textContent.trim(), className: spans[0].className, color: getComputedStyle(spans[0]).color },
      removed: { text: spans[1].textContent.trim(), className: spans[1].className, color: getComputedStyle(spans[1]).color },
      background: effectiveBackground(counts)
    };
  })()`);
}

/** Issue #924: drives the REAL composer Reasoning picker (click trigger, click the
 * `menuitemradio` whose own text matches `levelLabel`), then waits for the trigger's own visible
 * label to settle (pending spinner clears) before the caller reads the icon. Returns the
 * trigger's own final visible label text, which may differ from `levelLabel` requested (an
 * `inherit`/Default request OMP resolves to a real level, or does not confirm at all) -- the
 * caller derives its OWN expectation from whatever this returns, never from the requested label.
 */
export async function selectReasoningLevel(cdp, triggerFinderExpr, levelLabel) {
  await cdp.click(triggerFinderExpr);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: `Reasoning picker menu open (requesting "${levelLabel}")` });
  await cdp.click(
    `Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => el.textContent.trim() === ${JSON.stringify(levelLabel)})`
  );
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: `Reasoning picker menu closed (requesting "${levelLabel}")` });
  await cdp.waitFor(
    `(() => { const t = ${triggerFinderExpr}; return !!t && t.getAttribute('aria-busy') !== 'true'; })()`,
    { timeoutMs: 15_000, label: `Reasoning picker settled (requesting "${levelLabel}")` }
  );
  return cdp.evaluate(`(() => { const t = ${triggerFinderExpr}; return t ? t.querySelector('span')?.textContent.trim() : null; })()`);
}
