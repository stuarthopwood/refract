// Shared helpers for `scripts/verify-925-924-polish.mjs` (#925 diff-stat colouring, #924 reasoning
// gauge needle, #919 per-file header), split out for the #806 file-size cap.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseComputedColorToEntry, measuredContrastRatio } from './contrast-math.mjs';
import { resolveCssVarColor } from './verify-tauri-cdp.mjs';

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

// Unlike `makeScratchRepo` (empty initial tree), commits one tracked file so a worktree edit
// yields a real non-zero diffStat (#925).
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

/** Edits the tracked file inside a Session's worktree to make a `+3 -1` diff (both green and red branches).
 * Worktree checkout is CRLF (core.autocrlf) so split on `\r?\n` and rejoin with the original EOL;
 * the trailing '' marker is dropped first so it does not become a fourth added blank line. */
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

// Same 7-step angle formula as `ReasoningGaugeIcon.tsx`, so the expected angle is derived for
// whatever level the UI settles on rather than hardcoded per level.
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ARC_START_DEG = 150;
const ARC_SWEEP_DEG = 240;
const MEDIUM_INDEX = LEVELS.indexOf('medium');

export function needleAngleDeg(level) {
  const index = level ? LEVELS.indexOf(level) : -1;
  const stepIndex = index === -1 ? MEDIUM_INDEX : index;
  return ARC_START_DEG + (stepIndex * ARC_SWEEP_DEG) / (LEVELS.length - 1);
}

/** Reads the rendered gauge's needle `<path>` (`M12 14L{x} {y}`) and returns its angle in degrees
 * (0 = right, 90 = down, as in `needleAngleDeg`), or `null` if not found. */
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

/** Reads a `DiffStatCounts` pair of spans (+N, -N) under `containerExpr`: text, class, computed colour
 * and the nearest opaque backdrop. Backgrounds are collected in the browser and tested in Node via
 * `parseComputedColorToEntry`, since Dark themes report `oklch()`. `null` if not found. */
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
  // Only alpha === 1 is the real backdrop; `document.body` (pushed last) is the final fallback.
  const opaque = raw.backgrounds.find((bg) => parseComputedColorToEntry(bg)?.alpha === 1);
  return { added: raw.added, removed: raw.removed, background: opaque ?? raw.backgrounds[raw.backgrounds.length - 1] };
}

/** Asserts one `DiffStatCounts` pair's class/colour rule against the numbers in its own text.
 * `requireBothPositive` fails when removed reads zero, so an edit that never deleted cannot pass.
 * `tokenColors` also checks the computed colour, since a class name alone cannot catch a stripped
 * Tailwind utility (#928). */
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

/** Resolves the diff and muted colour tokens through a real probe element, since a `color-mix()`/`var()`
 * chain can only be finished by the browser cascade. Resolve once per theme. */
export async function resolveDiffTokenColors(cdp) {
  const [added, removed, muted] = await Promise.all([
    resolveCssVarColor(cdp, '--diff-added', 'color'),
    resolveCssVarColor(cdp, '--diff-removed', 'color'),
    resolveCssVarColor(cdp, '--muted-foreground', 'color')
  ]);
  return { added, removed, muted };
}

/** Drives the composer Reasoning picker to `levelLabel`, waits for the trigger to settle and returns its
 * final label, which may differ from the request (OMP resolves `inherit`); derive expectations from it. */
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
