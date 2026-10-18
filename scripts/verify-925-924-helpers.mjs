// Shared helpers for `scripts/verify-925-924-polish.mjs` (issue #925 diff-stat colouring across
// four surfaces, issue #924 reasoning gauge needle, issue #919 per-file header): split out from
// the start (#806 file-size ratchet -- the main script already needs every one of
// `verify-tauri-scratch-helpers.mjs`'s own exports plus a real GitHub PR flow plus a reasoning-
// level picker drive plus a gauge-needle reader, which would not fit the 600-line cap alone).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseComputedColorToEntry, measuredContrastRatio } from './contrast-math.mjs';
import { resolveCssVarColor } from './verify-tauri-cdp.mjs';

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
 * line look both removed and re-added).
 *
 * Gate round 2 fix (live-check H1, caught by a real CDP run measuring `+4 -1` instead of the
 * documented `+3 -1`): `raw.split(/\r?\n/)` on a file that ends with a newline (every commit
 * here does) produces a trailing `''` array element standing in for that one trailing newline,
 * not a real blank line. The old code left that element in place and then appended FOUR more
 * entries (`'line five'`, `'line six'`, `'line seven'`, a FRESH `''`) after it, turning the
 * former end-of-file artifact into a genuine new blank line in the middle of the file -- a real,
 * unintended fourth addition. Drops that one trailing marker first, so the three new lines land
 * directly after `'line four'` and the fresh `''` appended at the very end is once again only
 * the file's own trailing newline, never a visible line. */
export function editTrackedFileForDiff(worktreePath) {
  const filePath = path.join(worktreePath, TRACKED_FILE_NAME);
  const raw = readFileSync(filePath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const withoutTrailingMarker = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const withoutOne = withoutTrailingMarker.filter((line) => line !== 'line one');
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
 * `parentElement` for the first OPAQUE `background-color`, the same technique the real browser
 * cascade uses -- #927's own composer box made `--composer-background` transparent in two of
 * three themes specifically so the chat background paints through, so a naive "read this one
 * ancestor's background" guess would silently measure the wrong backdrop in those themes).
 * `null` if the container or its own `.tabular-nums` counts wrapper is not found.
 *
 * Gate round 2 fix (High, Main): the opacity walk used to parse ONLY `rgb()`/`rgba()` via a
 * hand-rolled regex, so it fell straight through to `document.body` on Dark and Dark (high
 * contrast) -- both report their own backgrounds as `oklch()` (Chromium's native serialisation
 * for any colour declared via the `oklch()`/`oklab()` CSS functions, which every `--background`/
 * `--muted`/`--popover` token in this codebase is), which the old regex never matched at all.
 * The browser-side walk below now only COLLECTS every ancestor's raw `backgroundColor` string
 * (plus `document.body`'s own as the final fallback); the actual opacity test runs in Node
 * through `parseComputedColorToEntry` (`contrast-math.mjs`), the SAME parser `measuredContrastRatio`
 * already uses for the colour values themselves -- one shared colour grammar, not two (a second,
 * rgb()-only copy here could silently drift from the real one again). */
export async function readDiffStatSpans(cdp, containerExpr) {
  const raw = await cdp.evaluate(`(() => {
    const container = ${containerExpr};
    if (!container) return null;
    const counts = container.querySelector('.tabular-nums');
    if (!counts) return null;
    // Gate round 1 fix: the counts wrapper may ALSO hold an sr-only accessible-label span
    // (\`DiffStatCounts\`'s own \`accessibleLabel\` prop) -- filtered out here so this always
    // resolves to exactly the two VISIBLE +N/-N spans, whether or not that prop is set.
    const spans = Array.from(counts.querySelectorAll(':scope > span')).filter((span) => !span.className.includes('sr-only'));
    if (spans.length !== 2) return null;
    const backgrounds = [];
    let node = counts;
    while (node) {
      backgrounds.push(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    backgrounds.push(getComputedStyle(document.body).backgroundColor);
    return {
      added: { text: spans[0].textContent.trim(), className: spans[0].className, color: getComputedStyle(spans[0]).color },
      removed: { text: spans[1].textContent.trim(), className: spans[1].className, color: getComputedStyle(spans[1]).color },
      backgrounds
    };
  })()`);
  if (!raw) return null;
  // Gate round 1 fix (L4): a PARTIALLY transparent background (alpha strictly between 0 and 1)
  // is not the real opaque backdrop either -- the true rendered colour still depends on
  // whatever is further beneath it. Only `alpha === 1` counts as "found"; anything else keeps
  // walking up (`document.body`'s own entry, always pushed last above, is the final fallback).
  const opaque = raw.backgrounds.find((bg) => parseComputedColorToEntry(bg)?.alpha === 1);
  return { added: raw.added, removed: raw.removed, background: opaque ?? raw.backgrounds[raw.backgrounds.length - 1] };
}

/** Issue #925: asserts one `DiffStatCounts` pair's own class/colour rule against the real
 * numbers parsed out of its own text -- never trusting the app to have applied the rule
 * correctly, deriving the expectation independently from `+N`/`-N` text each time.
 *
 * Gate round 1 fix (H2): `requireBothPositive` (the chip/card non-zero call sites, where this
 * script itself controls the edit and so KNOWS both should be positive) turns "removed happened
 * to read zero" into a hard failure instead of a silent, semantically-true-but-wrong "zero stays
 * muted" pass -- the whole point of that edit is to exercise BOTH the green and the red branch,
 * and a script bug that only ever produced an addition must not pass as if it had. The PR
 * surfaces (real GitHub data, not scripted) leave this off: a real PR's own deletions count is
 * outside this script's control.
 *
 * Gate round 2 fix (Low, Main): parses with `\D` (strip every non-digit), not `[^\d-]` (strip
 * every non-digit-or-minus) -- the removed span's own text is literally "-N" (`DiffStatCounts`'s
 * `-{removedText}` glyph, not a numeric sign), so the old pattern kept that glyph and parsed
 * every real removed count as negative (harmless here, since both branches below only ever
 * compare against `=== 0`/`> 0` through `requireBothPositive`, but the same bug silently broke
 * the PR row scan's own `probeRemoved`, which this script's `\D` fix already matches).
 *
 * Gate round 2 (Medium, Main): `tokenColors` (when supplied, `resolveDiffTokenColors`'s own
 * `{ added, removed, muted }`, resolved through a REAL probe element per theme) asserts the
 * span's own COMPUTED colour too, not only its class name -- a class name alone cannot catch a
 * Tailwind build that silently stripped or mis-mapped the utility (exactly the #928 bug this
 * same PLAN.md row already found once, in `tailwind-merge`), the stricter version of #570's own
 * "check the token actually rendered" rule. */
export function assertDiffStatSpans(label, spans, findings, failures, { requireBothPositive = false, tokenColors = null } = {}) {
  if (!spans) {
    failures.push(`${label}: DiffStatCounts spans not found.`);
    return;
  }
  const addedN = parseInt(spans.added.text.replace(/\D/g, ''), 10);
  const removedN = parseInt(spans.removed.text.replace(/\D/g, ''), 10);
  if (requireBothPositive && (addedN === 0 || removedN === 0)) {
    failures.push(`${label}: expected BOTH added and removed strictly positive (this edit controls the diff) to exercise both the green and the red branch -- got "+${addedN} -${removedN}".`);
  }
  for (const [name, entry, n, expectedClass, expectedTokenColor] of [
    ['added', spans.added, addedN, 'text-diff-added', tokenColors?.added],
    ['removed', spans.removed, removedN, 'text-diff-removed', tokenColors?.removed]
  ]) {
    const expectMuted = n === 0;
    const hasExpectedClass = entry.className.includes(expectedClass);
    const hasMutedClass = entry.className.includes('text-muted-foreground');
    if (expectMuted) {
      if (hasMutedClass && !hasExpectedClass) findings.push(`${label}: ${name} "${entry.text}" is zero, stays text-muted-foreground, as #925 decides.`);
      else failures.push(`${label}: ${name} "${entry.text}" is zero but class is "${entry.className}" -- expected text-muted-foreground, never ${expectedClass}.`);
      if (tokenColors) {
        if (entry.color === tokenColors.muted) findings.push(`${label}: ${name} computed colour ${entry.color} matches --muted-foreground, as a zero count decides.`);
        else failures.push(`${label}: ${name} computed colour ${entry.color} does not match --muted-foreground's own resolved value (${tokenColors.muted}).`);
      }
    } else {
      if (hasExpectedClass && !hasMutedClass) findings.push(`${label}: ${name} "${entry.text}" is positive, takes ${expectedClass}, as #925 decides.`);
      else failures.push(`${label}: ${name} "${entry.text}" is positive but class is "${entry.className}" -- expected ${expectedClass}.`);
      if (tokenColors) {
        if (entry.color === expectedTokenColor && entry.color !== tokenColors.muted) findings.push(`${label}: ${name} computed colour ${entry.color} matches --diff-${name}'s own resolved value and differs from --muted-foreground.`);
        else failures.push(`${label}: ${name} computed colour ${entry.color} does not match --diff-${name}'s own resolved value (${expectedTokenColor}), or equals --muted-foreground.`);
      }
    }
    const ratio = measuredContrastRatio(entry.color, spans.background);
    if (ratio === null) failures.push(`${label}: could not parse ${name} colour (${entry.color}) or backdrop (${spans.background}) for a measured contrast ratio.`);
    else if (ratio < 4.5) failures.push(`${label}: ${name} measures ${ratio.toFixed(2)}:1 against its own rendered backdrop (${entry.color} on ${spans.background}), below the 4.5:1 WCAG AA text floor.`);
    else findings.push(`${label}: ${name} measures ${ratio.toFixed(2)}:1 against its own rendered backdrop (${entry.color} on ${spans.background}), clears 4.5:1.`);
  }
}

/** Issue #925 gate round 2 (Medium, Main): resolves `--diff-added`/`--diff-removed`/
 * `--muted-foreground` through a REAL probe element's own `getComputedStyle()`
 * (`resolveCssVarColor`, `verify-tauri-cdp.mjs`) -- the SAME technique #927's own gate already
 * established for `--composer-focus`/`--ring` -- so `assertDiffStatSpans` can compare a span's
 * own computed colour against the token's resolved value, never a hardcoded literal that could
 * drift from a `color-mix()`/`var()` chain only the browser's cascade can finish computing.
 * Resolved once per theme (the three colours never change mid-theme), reused across every
 * surface checked under that theme. */
export async function resolveDiffTokenColors(cdp) {
  const [added, removed, muted] = await Promise.all([
    resolveCssVarColor(cdp, '--diff-added', 'color'),
    resolveCssVarColor(cdp, '--diff-removed', 'color'),
    resolveCssVarColor(cdp, '--muted-foreground', 'color')
  ]);
  return { added, removed, muted };
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
