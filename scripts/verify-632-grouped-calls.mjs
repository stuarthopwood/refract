#!/usr/bin/env node
// Live CDP check for issue #632 (borderless thread for grouped tool calls and bash/grep/glob/
// read calls; supersedes #430). Modeled on `verify-570-tool-colours.mjs`/`verify-565-spine.mjs`:
// a REAL `omp` (ambient already-signed-in default profile, no `OMP_PROFILE` override), scratch
// cwd/worktree/`REFRACT_DATA_DIR`, never touching Stuart's real Session list.
//
// #632's own structural acceptance (no border, hover tints one row, the Error line under a
// collapsed failed row, no Arguments/Output on expand) was already live-checked by #565/#570
// (#628 landed no live-check script of its own, so it is not cited here) -- not re-proven from
// scratch, except two cheap direct assertions gate round 1 added (no command text in the
// collapsed header, hover tints one row only). Proves everything THIS story added:
//   (a) a group's header reads "<tool> ×N" (never a call's command), failed/interrupted counts
//       AND the group's own total time (summed from every member) in the meta slot;
//   (b) `bash` reads "$ <command>", `grep` reads `grep "<pattern>" <path>`;
//   (c) a row's command text wraps once expanded, no code-block element, no output text (H6);
//   (d) an `edit` call's own row shows its "+N −M" stat alongside duration;
//   (e) the SAME grammar renders inside the Subagents panel (shared `ToolGroupRow`);
//   (f) hover tints only the hovered row, never a nested ancestor, collapsed AND expanded (M8, D10);
//   (g) an expanded two-bash group is about 4 lines tall (M8, measured);
//   (h) keyboard Tab/Shift+Tab reaches the header with a visible focus outline, each member's
//       own accessible name includes its tool and command (M8);
//   (i) hostile output (ANSI byte, a very long line) renders inert and bounded, in BOTH the
//       Error line and the row's own summary text, collapsed and expanded (M8, D9).
//
// Six turns, one scratch Session (Approval mode seeded to Auto, no approval-card boundary):
// (a) two bash, #2 failing. (b) grep. (c) read -- UNCHANGED. (d) edit -- the stat. (e) one
// `task()` subagent, two bash (one failing), read from the Subagents panel. (f) one bash with
// an ANSI byte and a very long line, failing.

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  assertExeUnchanged,
  requireSharedCargoTarget,
  sha256OfFile,
  getAccessibleNameAndRole
} from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_632_SHOTS_DIR || path.join(tmpdir(), 'refract-632-grouped-calls-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// #632-only source text: `commandRowText`'s grep branch builds `grep "<pattern>"` -- the literal
// `grep "` substring does not exist anywhere else in this codebase, so its presence in the
// built, non-minified dev renderer bundle cheaply proves this exe contains #632's own code
// (same pattern `verify-570-tool-colours.mjs`'s own marker check established).
function assertBundleContainsStory632Marker() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  if (!existsSync(assetsDir)) throw new Error(`assertBundleContainsStory632Marker: ${assetsDir} not found -- the renderer build did not run or wrote elsewhere.`);
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const text = readFileSync(path.join(assetsDir, file), 'utf8');
    if (text.includes('grep "')) {
      console.log(`verify-632: confirmed #632-only marker 'grep "' present in the built renderer bundle (${file}).`);
      return;
    }
  }
  throw new Error('assertBundleContainsStory632Marker: \'grep "\' not found in any built renderer asset -- this build does not contain #632\'s code.');
}

const TURN_A_PROMPT =
  "Make exactly TWO separate bash tool calls, strictly in this order, waiting for each one to finish before starting the next: first run exactly `sleep 1 && echo t632-one`, second run exactly `exit 9` (which deliberately fails with no output). After both finish, reply with exactly the single word 't632a' and nothing else.";
const TURN_B_PROMPT =
  "Make exactly ONE grep tool call searching for the exact pattern `t632GrepMarker` in the path `.`, then reply with exactly the single word 't632b' and nothing else.";
const TURN_C_PROMPT =
  "Make exactly ONE read tool call reading the file `t632-read-target.txt` in the repository root, then reply with exactly the single word 't632c' and nothing else.";
const TURN_D_PROMPT =
  "Make exactly ONE edit tool call on the file `t632-edit-target.txt` in the repository root, changing its line `one` to `one-edited`, then reply with exactly the single word 't632d' and nothing else.";
const TURN_E_PROMPT =
  "Use the task tool to start exactly ONE background subagent (a single entry in `tasks`) whose own prompt instructs it to make exactly TWO bash tool calls, the second one deliberately failing with `exit 9`, then reply with exactly the single word 't632e'. Then, once the subagent has finished, reply with exactly the single word 't632e-done' and nothing else.";
// A REAL ESC byte (U+001B) embedded directly in the prompt text -- `echo` emits it verbatim, no
// shell-side escape interpretation (a prior `printf '\033[...'` attempt never reached `item.output`).
const HOSTILE_LONG_LINE = 'X'.repeat(250);
const TURN_F_PROMPT =
  `Make exactly ONE bash tool call that runs exactly this, byte for byte, with no retyping or reinterpreting: \`echo '\x1b[31mHostile\x1b[0m ${HOSTILE_LONG_LINE}'; exit 5\` (deliberately fails; its output has a real ANSI colour escape byte and a very long line). Then reply with exactly the single word 't632f' and nothing else.`;

const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;
// Every top-level TOOL-call group header button. A label matching issue #632's own closed tool
// identifiers (OMP's own `tool` field, optionally with a " \u00d7N" multi-call suffix) excludes
// a Thought run or Stage/subagent entry, which share the same `CollapsedLine` markup and
// `span.font-medium` span (a real run showed `Thought for 1s` hijacking `.at(0)`). M2 (this same
// gate round) then drops the label for a solo `bash`/`grep` row -- accepted too when its own
// summary starts with the command-style grammar (`$ `/`grep "`), confirmed live: without this,
// `.at(-1)` fell back to the multi-call group's own empty spacer span for turn (b)'s grep row.
// Gate round 2 (Main, D8): excludes any button inside a Spine `ol.border-l` -- an EXPANDED
// group's own member buttons (`ToolCallRow`) match the exact same label-less `$ `/`grep "`
// fallback this finder needs for a solo header, so without this exclusion a header index/count
// could silently resolve to a member row once a group is expanded.
const GROUP_HEADERS = `Array.from(${TRANSCRIPT}.querySelectorAll('button')).filter((el) => {
  if (el.closest('ol.border-l')) return false;
  const l = el.querySelector('span.font-medium');
  if (l) return /^(?:bash|grep|glob|find|read|write|edit)(?:\\s*\\u00d7\\d+)?$/.test((l.textContent || '').trim());
  const s = el.querySelector('span.min-w-0.flex-1');
  const t = s ? (s.textContent || '').trim() : '';
  return /^\\$ /.test(t) || /^grep "/.test(t);
})`;
const BASH_GROUP_LABEL = /^bash\s*\u00d72$/;

// Gate round 1 (test-reviewer Medium, M7): now also reads the header's own SUMMARY span (never
// just label/meta) so a caller can assert it is empty -- #632's own acceptance is that a
// multi-call group's collapsed header never shows any call's own command text.
function groupHeaderInfo(index) {
  return `(() => {
    const h = (${GROUP_HEADERS}).at(${index});
    if (!h) return null;
    const label = h.querySelector('span.font-medium');
    const summaryHost = h.querySelector('span.min-w-0.flex-1');
    const metaHost = h.querySelector('span.tabular-nums');
    return {
      labelText: label ? label.textContent.trim() : null,
      summaryText: summaryHost ? summaryHost.textContent.trim() : null,
      metaText: metaHost ? metaHost.textContent.replace(/^,\\s*/, '').trim() : null,
      ariaExpanded: h.getAttribute('aria-expanded'),
    };
  })()`;
}

// Parses `formatDuration`'s two shapes ("127ms", "1.3s") back to ms; `null` for anything else.
function parseDurationMs(text) {
  if (!text) return null;
  const sMatch = text.match(/(\d+(?:\.\d+)?)s$/);
  if (sMatch) return Math.round(parseFloat(sMatch[1]) * 1000);
  const msMatch = text.match(/(\d+)ms$/);
  if (msMatch) return parseInt(msMatch[1], 10);
  return null;
}

async function pressKey(cdp, { windowsVirtualKeyCode, key, code, shift = false }) {
  const modifiers = shift ? 8 : 0;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode, key, code, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode, key, code, modifiers });
}
function pressTab(cdp, { shift = false } = {}) {
  return pressKey(cdp, { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', shift });
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirtyFlag = 'unknown';
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-632-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-632-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-632-repo-')), 'verify-632-grouped-calls');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-632-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-632-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));

    // Scratch targets turns (b)/(c)/(d) read or edit, COMMITTED (not merely written to `repoDir`'s
    // own working copy) so `grep`/`read`/`edit` all see a real, tracked file: Refract creates a
    // brand-new `git worktree` per Session (`src-tauri/src/git/worktrees.rs`), which only ever
    // materialises committed content -- an uncommitted file here would read "not found" there.
    writeFileSync(path.join(repoDir, 't632-read-target.txt'), 'one\ntwo\nthree\n');
    writeFileSync(path.join(repoDir, 't632-edit-target.txt'), 'one\ntwo\nthree\n');
    appendFileSync(path.join(repoDir, 'README-t632grep.txt'), 'line containing t632GrepMarker here\n');
    const seedAdd = spawnSync('git', ['-C', repoDir, 'add', '-A'], { encoding: 'utf8', windowsHide: true });
    if (seedAdd.status !== 0) throw new Error(`verify-632: git add of scratch targets failed: ${seedAdd.stderr || seedAdd.stdout}`);
    const seedCommit = spawnSync(
      'git',
      ['-C', repoDir, '-c', 'user.name=verify-632-grouped-calls', '-c', 'user.email=verify-632-grouped-calls@example.invalid', 'commit', '-q', '-m', 'seed t632 scratch targets'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (seedCommit.status !== 0) throw new Error(`verify-632: git commit of scratch targets failed: ${seedCommit.stderr || seedCommit.stdout}`);

    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    if (gitStatusResult.status === 0) {
      const dirtyLines = gitStatusResult.stdout.split('\n').filter(Boolean);
      dirtyFlag = dirtyLines.length ? dirtyLines : false;
    }
    console.log(`verify-632: git HEAD ${gitHeadSha}${dirtyFlag === 'unknown' ? ' (dirty flag unknown: git status failed)' : dirtyFlag ? ` (DIRTY: ${dirtyFlag.length} path(s))` : ''}`);
    console.log(`verify-632: shots dir ${SHOTS_DIR}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-632' });
    assertBundleContainsStory632Marker();
    findings.push('Built renderer bundle contains the #632-only `grep "` marker text (verified before launch).');
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-632: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-632');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' },
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' },
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled',
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // ---- Turn (a): 2 bash calls, #2 fails -- the group header's own "<tool> ×N" grammar ----
    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t632a/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (a) finished' },
    );
    const headerA = await cdp.evaluate(groupHeaderInfo(0));
    if (!headerA) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-no-group.png'));
      throw new Error('verify-632: no tool-group header found after turn (a).');
    }
    if (!BASH_GROUP_LABEL.test(headerA.labelText ?? '')) {
      failures.push(`Turn (a) group header label is "${headerA.labelText}", expected to match /${BASH_GROUP_LABEL}/ ("bash ×2", never a call's own command).`);
    } else {
      findings.push(`Turn (a) group header label reads "${headerA.labelText}" (tool + count, not a call's own command).`);
    }
    // Gate round 1 (test-reviewer Medium, M7): the header's own summary span must be EMPTY --
    // #632's own acceptance is that the collapsed header never shows any call's own command.
    if (headerA.summaryText) {
      failures.push(`Turn (a) group header's own summary text is "${headerA.summaryText}", expected empty (no call's own command shown in the header).`);
    } else {
      findings.push("Turn (a) group header shows no summary text at all (no call's own command named).");
    }
    if (!headerA.metaText || !headerA.metaText.includes('1 failed')) {
      failures.push(`Turn (a) group header meta text is "${headerA.metaText}", expected to contain "1 failed".`);
    } else if (!/\d+(\.\d+)?(ms|s)$/.test(headerA.metaText)) {
      failures.push(`Turn (a) group header meta text "${headerA.metaText}" has no trailing duration -- the group's own total time (sum of every member's duration) is missing.`);
    } else {
      findings.push(`Turn (a) group header meta text reads "${headerA.metaText}" (failed count and total time joined).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '00-turn-a-collapsed-group.png'));

    // Gate round 1 (ui-architect-v3 High, M8): hover tints ONLY the hovered row -- the Collapsible
    // ROOT (an ancestor of the trigger the hover class lives on) must show the SAME background
    // before and after, while the trigger's own background changes (#430's own regression class).
    const hoverAncestorBefore = await cdp.evaluate(
      `(() => { const h = (${GROUP_HEADERS}).at(0); const root = h ? h.closest('[data-slot="collapsible"]') : null; return root ? getComputedStyle(root).backgroundColor : null; })()`,
    );
    const hoverTriggerBefore = await cdp.evaluate(`(() => { const h = (${GROUP_HEADERS}).at(0); return h ? getComputedStyle(h).backgroundColor : null; })()`);
    const hoverRect = await cdp.evaluate(`(() => { const h = (${GROUP_HEADERS}).at(0); if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (hoverRect) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverRect.x, y: hoverRect.y });
    const hoverAncestorAfter = await cdp.evaluate(
      `(() => { const h = (${GROUP_HEADERS}).at(0); const root = h ? h.closest('[data-slot="collapsible"]') : null; return root ? getComputedStyle(root).backgroundColor : null; })()`,
    );
    const hoverTriggerAfter = await cdp.evaluate(`(() => { const h = (${GROUP_HEADERS}).at(0); return h ? getComputedStyle(h).backgroundColor : null; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    if (hoverAncestorBefore !== hoverAncestorAfter) {
      failures.push(`Hovering the group header changed its OWN Collapsible-root ancestor's background (${hoverAncestorBefore} -> ${hoverAncestorAfter}) -- decision 18 requires only the trigger itself to tint, never a nested ancestor box (#430's own regression).`);
    } else if (hoverTriggerBefore === hoverTriggerAfter) {
      failures.push(`Hovering the group header did not change its own trigger background (stayed ${hoverTriggerBefore}) -- expected the hover tint to apply.`);
    } else {
      findings.push(`Hover tints only the trigger itself (${hoverTriggerBefore} -> ${hoverTriggerAfter}); its own Collapsible-root ancestor stayed ${hoverAncestorAfter} (#430's own regression class, not reintroduced).`);
    }

    // Expand the group (this click also gives the header DOM focus).
    await cdp.click(`(${GROUP_HEADERS}).at(0)`);
    await cdp.waitFor(`(${GROUP_HEADERS}).at(0).getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Turn (a) group expanded' });

    // Gate round 1 (accessibility-auditor Medium, M8): the click gave mouse-acquired focus (no
    // :focus-visible); Tab away then Shift+Tab back forces a genuine keyboard refocus.
    await pressTab(cdp);
    await pressTab(cdp, { shift: true });
    const keyboardFocusCheck = await cdp.evaluate(`(() => {
      const h = (${GROUP_HEADERS}).at(0);
      if (!h) return null;
      const isActive = document.activeElement === h;
      const s = getComputedStyle(h);
      return { isActive, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
    })()`);
    if (!keyboardFocusCheck || !keyboardFocusCheck.isActive) {
      failures.push(`Tab then Shift+Tab did not return keyboard focus to the group header (measured ${JSON.stringify(keyboardFocusCheck)}).`);
    } else if (keyboardFocusCheck.outlineStyle === 'none' || keyboardFocusCheck.outlineWidth === '0px') {
      failures.push(`Group header has keyboard focus but no visible outline (outlineStyle=${keyboardFocusCheck.outlineStyle}, outlineWidth=${keyboardFocusCheck.outlineWidth}).`);
    } else {
      findings.push(`Keyboard Tab/Shift+Tab reaches the group header with a visible focus outline (${keyboardFocusCheck.outlineStyle} ${keyboardFocusCheck.outlineWidth}).`);
    }

    // Gate round 1 (ui-architect-v3 Medium, M8): expanded group (members collapsed) measured
    // against its own line-height -- the issue's own "about 4 lines, against about 20 today".
    const heightCheck = await cdp.evaluate(`(() => {
      const h = (${GROUP_HEADERS}).at(0);
      const root = h ? h.closest('[data-slot="collapsible"]') : null;
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(h).lineHeight);
      return { heightPx: rect.height, lineHeightPx: lineHeight, lines: lineHeight ? rect.height / lineHeight : null };
    })()`);
    if (!heightCheck || heightCheck.lines == null) {
      failures.push(`Could not measure the expanded group's own height against its line-height (${JSON.stringify(heightCheck)}).`);
    } else if (heightCheck.lines < 3 || heightCheck.lines > 6) {
      failures.push(`Expanded group (members collapsed) measured ${heightCheck.lines.toFixed(1)} lines tall (${heightCheck.heightPx.toFixed(0)}px / ${heightCheck.lineHeightPx.toFixed(0)}px line-height), expected about 4.`);
    } else {
      findings.push(`Expanded group (members collapsed) measured ${heightCheck.lines.toFixed(1)} lines tall -- matches the issue's own "about 4 lines, against about 20 today".`);
    }

    // Gate round 1 (test-reviewer Medium, M7): scoped to THIS group's own <ol>, not every <li>
    // in the whole transcript (a future group's own members would otherwise be picked up too).
    const memberButtons = `(() => { const h = (${GROUP_HEADERS}).at(0); const root = h ? h.closest('[data-slot="collapsible"]') : null; const ol = root ? root.querySelector('ol.border-l') : null; return ol ? Array.from(ol.querySelectorAll('li button')) : []; })()`;
    const memberCount = await cdp.evaluate(`(${memberButtons}).length`);
    if (memberCount !== 2) failures.push(`Expected 2 member rows inside the expanded group, found ${memberCount}.`);
    else findings.push('Expanded group shows both members down the shared Spine.');

    // Gate round 2 (Main, D10): hovering a MEMBER of an expanded group must tint only that
    // member -- never the group's own trigger background nor add a border to any ancestor
    // (#430's regression class, re-checked here: the member sits in a different ancestor chain).
    const memberHoverState = `(() => {
      const h = (${GROUP_HEADERS}).at(0);
      const b = (${memberButtons}).at(0);
      if (!h || !b) return null;
      const ancestorBorders = [];
      for (let node = b.parentElement; node && node !== document.body; node = node.parentElement) ancestorBorders.push(getComputedStyle(node).borderTopWidth);
      return { triggerBg: getComputedStyle(h).backgroundColor, ancestorBorders };
    })()`;
    const memberHoverBefore = await cdp.evaluate(memberHoverState);
    const memberHoverRect = await cdp.evaluate(`(() => { const b = (${memberButtons}).at(0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (memberHoverRect) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: memberHoverRect.x, y: memberHoverRect.y });
    const memberHoverAfter = await cdp.evaluate(memberHoverState);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    if (!memberHoverBefore || !memberHoverAfter) {
      failures.push('Could not measure hover state for an expanded group member (D10).');
    } else if (memberHoverBefore.triggerBg !== memberHoverAfter.triggerBg) {
      failures.push(`Hovering an expanded group's own member changed the GROUP TRIGGER's background (${memberHoverBefore.triggerBg} -> ${memberHoverAfter.triggerBg}).`);
    } else if (JSON.stringify(memberHoverBefore.ancestorBorders) !== JSON.stringify(memberHoverAfter.ancestorBorders)) {
      failures.push(`Hovering an expanded group's own member changed an ancestor's borderTopWidth (${JSON.stringify(memberHoverBefore.ancestorBorders)} -> ${JSON.stringify(memberHoverAfter.ancestorBorders)}) -- #430's own regression class.`);
    } else {
      findings.push(`Hovering an expanded group's own member leaves the trigger (${memberHoverAfter.triggerBg}) and every ancestor's borderTopWidth unchanged (#430's class, not reintroduced).`);
    }

    // Gate round 1 (test-reviewer Medium, M7): the header's own total time must equal the SUM of
    // the member durations (parsed and added, not just "has a trailing duration").
    const memberMetaTexts = await cdp.evaluate(`(${memberButtons}).map((b) => { const m = b.querySelector('span.tabular-nums'); return m ? m.textContent.replace(/^,\\s*/, '').trim() : null; })`);
    const memberDurationsMs = memberMetaTexts.map(parseDurationMs);
    const headerTotalMatch = (headerA.metaText ?? '').match(/(\d+(?:\.\d+)?(?:ms|s))$/);
    const headerTotalMs = headerTotalMatch ? parseDurationMs(headerTotalMatch[1]) : null;
    if (memberDurationsMs.some((ms) => ms == null) || headerTotalMs == null) {
      failures.push(`Could not parse every duration to compare the sum (members: ${JSON.stringify(memberMetaTexts)}, header: "${headerA.metaText}").`);
    } else {
      const sumMs = memberDurationsMs.reduce((a, b) => a + b, 0);
      // Rounding allowed: each duration is independently rounded, so the displayed total can
      // differ from the sum of displayed members by a little; 150ms covers that.
      const deltaMs = Math.abs(sumMs - headerTotalMs);
      if (deltaMs > 150) {
        failures.push(`Group header's own total time (${headerTotalMs}ms) does not equal the sum of its members' own durations (${memberMetaTexts.join(' + ')} = ${sumMs}ms, delta ${deltaMs}ms).`);
      } else {
        findings.push(`Group header's own total time (${headerTotalMs}ms) equals the sum of its members' own durations (${memberMetaTexts.join(' + ')} = ${sumMs}ms, delta ${deltaMs}ms, rounding allowed).`);
      }
    }

    // Gate round 1 (accessibility-auditor Medium, M8): each member's accessible name must
    // include its tool and command, not just the browser's own content-based concatenation.
    const member0Ax = await getAccessibleNameAndRole(cdp, `(${memberButtons}).at(0)`);
    const member1Ax = await getAccessibleNameAndRole(cdp, `(${memberButtons}).at(1)`);
    if (!member0Ax.name || !member0Ax.name.includes('bash') || !member0Ax.name.includes('t632-one')) {
      failures.push(`First member's own accessible name is "${member0Ax.name}", expected it to include "bash" and "t632-one".`);
    } else {
      findings.push(`First member's own accessible name includes both tool and command: "${member0Ax.name}".`);
    }
    if (!member1Ax.name || !member1Ax.name.includes('bash') || !member1Ax.name.includes('exit 9')) {
      failures.push(`Second member's own accessible name is "${member1Ax.name}", expected it to include "bash" and "exit 9".`);
    } else {
      findings.push(`Second member's own accessible name includes both tool and command: "${member1Ax.name}".`);
    }

    const member0Summary = await cdp.evaluate(`(() => { const b = (${memberButtons}).at(0); const s = b ? b.querySelector('span.min-w-0.flex-1') : null; return s ? s.textContent.trim() : null; })()`);
    if (!member0Summary || !member0Summary.startsWith('$ ')) {
      failures.push(`First member row's own text is "${member0Summary}", expected it to start with "$ " (the bash command-style form).`);
    } else {
      findings.push(`First member row reads "${member0Summary}" ($ plus the command, not the raw target).`);
    }
    await cdp.click(`(${memberButtons}).at(0)`);
    await cdp.waitFor(`(${memberButtons}).at(0).getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'First member expanded' });
    // Gate round 1 (test-reviewer High, M7): reads the COMPUTED `white-space` (not just absence
    // of a class name) and asserts no code-block element and no output text at all (H6).
    const member0ExpandedCheck = await cdp.evaluate(`(() => {
      const b = (${memberButtons}).at(0);
      const s = b ? b.querySelector('span.min-w-0.flex-1') : null;
      const whiteSpace = s ? getComputedStyle(s).whiteSpace : null;
      const root = b ? b.closest('[data-slot="collapsible"]') : null;
      const content = root ? root.querySelector('[data-slot="collapsible-content"]') : null;
      const hasCodeBlock = content ? !!content.querySelector('pre, code, [data-slot="code-block"]') : null;
      // "View full call" (ToolCallDialog.tsx) is a permanent <button>; excluded so only real output text (a <p>) counts.
      const contentClone = content ? content.cloneNode(true) : null;
      if (contentClone) contentClone.querySelectorAll('button').forEach((btn) => btn.remove());
      const contentText = contentClone ? contentClone.textContent.trim() : null;
      return { whiteSpace, hasCodeBlock, contentText, hasContent: !!content };
    })()`);
    if (!member0ExpandedCheck || member0ExpandedCheck.whiteSpace !== 'normal') {
      failures.push(`Expanded first member's own summary computed white-space is "${member0ExpandedCheck?.whiteSpace}", expected "normal" (wraps instead of truncating).`);
    } else {
      findings.push("Expanded first member's own command text computed white-space is \"normal\" (wraps, not truncate).");
    }
    // Gate round 2 (Main, D8): `content` missing entirely used to fall through to the SAME
    // "no code block, no output" finding as a genuinely clean expansion -- a vacuous pass that
    // never actually looked at anything. Checked explicitly first, as its own failure.
    if (!member0ExpandedCheck?.hasContent) {
      failures.push("Expanded first member's own collapsible-content region was not found -- cannot confirm no code-block/output element (no vacuous pass).");
    } else if (member0ExpandedCheck.hasCodeBlock) {
      failures.push("Expanded first member's own body contains a pre/code/code-block element -- #632's own acceptance is no boxed Arguments/Output block.");
    } else if (member0ExpandedCheck.contentText) {
      failures.push(`Expanded first member's own body shows output text ("${member0ExpandedCheck.contentText}") -- a successful bash call must show none (gate round 1, H6).`);
    } else {
      findings.push('Expanded first member (a successful bash call) shows no code block and no output text at all (gate round 1, H6).');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-turn-a-expanded-member.png'));

    // ---- Turn (b): one grep call -- the command-style row text `grep "<pattern>" <path>` ----
    await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t632b/g) ?? []).length >= 2; })()`, { timeoutMs: 180_000, label: 'Turn (b) finished' });
    const grepHeaderText = await cdp.evaluate(`(() => { const hs = ${GROUP_HEADERS}; const h = hs.at(-1); const s = h ? h.querySelector('span.min-w-0.flex-1') : null; return s ? s.textContent.trim() : null; })()`);
    if (!grepHeaderText || !grepHeaderText.startsWith('grep "t632GrepMarker"')) {
      failures.push(`Grep call's own row text is "${grepHeaderText}", expected it to start with grep "t632GrepMarker".`);
    } else {
      findings.push(`Grep call's own row reads "${grepHeaderText}" (command-style form).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-turn-b-grep.png'));

    // ---- Turn (c): one read call -- row text UNCHANGED (still just the path) ----
    await cdp.typeIntoByLabel('Message', TURN_C_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t632c/g) ?? []).length >= 2; })()`, { timeoutMs: 180_000, label: 'Turn (c) finished' });
    const readHeaderText = await cdp.evaluate(`(() => { const hs = ${GROUP_HEADERS}; const h = hs.at(-1); const s = h ? h.querySelector('span.min-w-0.flex-1') : null; return s ? s.textContent.trim() : null; })()`);
    if (!readHeaderText || !readHeaderText.includes('t632-read-target.txt')) {
      failures.push(`Read call's own row text is "${readHeaderText}", expected it to contain the read path, unchanged by #632.`);
    } else {
      findings.push(`Read call's own row reads "${readHeaderText}" (unchanged, no reshaping for this tool).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '03-turn-c-read.png'));

    // ---- Turn (d): one edit call -- the row's own "+N −M" stat ----
    await cdp.typeIntoByLabel('Message', TURN_D_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t632d/g) ?? []).length >= 2; })()`, { timeoutMs: 180_000, label: 'Turn (d) finished' });
    const editMetaText = await cdp.evaluate(`(() => { const hs = ${GROUP_HEADERS}; const h = hs.at(-1); const m = h ? h.querySelector('span.tabular-nums') : null; return m ? m.textContent.trim() : null; })()`);
    if (!editMetaText || !/\+\d+/.test(editMetaText) || !/[\u2212-]\d+/.test(editMetaText)) {
      failures.push(`Edit call's own meta text is "${editMetaText}", expected an added/removed "+N -M" stat.`);
    } else {
      findings.push(`Edit call's own row shows its own diff stat: "${editMetaText}".`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '04-turn-d-edit.png'));

    // ---- Turn (e): the Subagents panel reuses the exact same grammar ----
    await cdp.typeIntoByLabel('Message', TURN_E_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t632e-done/g) ?? []).length >= 2; })()`, { timeoutMs: 240_000, label: 'Turn (e) finished (subagent done, main agent replied)' });
    // `SubagentChainRow`'s own "Show subagents panel" button only renders for TWO+ Stages
    // (FR-065); this turn starts one subagent, so the readout bar's own `SubagentsChip` opens
    // it instead, with a dynamic accessible name -- "Open subagents panel (1 finished)".
    await cdp.clickByLabel('Open subagents panel', { prefix: true });
    await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagents panel open' });
    await cdp.click(`document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"], [role="tree"][aria-label="Subagents"] button')`);
    // `SubagentPanel.tsx`'s own stream pane has no `[role="tabpanel"]`/`<aside>` wrapper --
    // scoped to the stable `#right-pane-active-panel` host every hosted panel renders inside.
    const PANEL_GROUP_HEADERS = `Array.from(document.querySelectorAll('#right-pane-active-panel button')).filter((el) => el.querySelector('span.font-medium'))`;
    // A plain one-shot `evaluate` right after the click raced the stream pane's own render in
    // two prior live runs (the screenshot a moment later always showed the row already there) --
    // polled instead, same as every other post-click assertion in this file.
    let panelHeaderInfo = null;
    try {
      panelHeaderInfo = await cdp.waitFor(
        `(() => {
          const h = (${PANEL_GROUP_HEADERS}).find((el) => { const l = el.querySelector('span.font-medium'); return l && /^bash(\\s*\\u00d72)?$/.test(l.textContent.trim()); });
          if (!h) return null;
          const label = h.querySelector('span.font-medium');
          const metaHost = h.querySelector('span.tabular-nums');
          return { labelText: label.textContent.trim(), metaText: metaHost ? metaHost.textContent.replace(/^,\\s*/, '').trim() : null };
        })()`,
        { timeoutMs: 10_000, label: "Subagents panel's own bash group header" },
      );
    } catch {
      panelHeaderInfo = null;
    }
    if (!panelHeaderInfo) {
      notExercised.push('Could not find the subagent\'s own bash group header inside the Subagents panel stream (panel layout or timing did not match this script\'s selector); the main-transcript assertions above already cover the shared component.');
    } else if (!BASH_GROUP_LABEL.test(panelHeaderInfo.labelText)) {
      failures.push(`Subagents panel's own bash group header reads "${panelHeaderInfo.labelText}", expected the same "bash ×2" grammar the main transcript uses (design point 4, one row component used everywhere).`);
    } else {
      findings.push(`Subagents panel's own bash group header reads "${panelHeaderInfo.labelText}" -- the SAME grammar as the main transcript (shared \`ToolGroupRow\`).`);
      // Gate round 1 (test-reviewer Medium, M7): also assert the meta slot's own failed count,
      // not just the label. A live run showed the subagent's own group with NO trailing total
      // time ("1 failed" bare) -- M6's own "omit a partial sum, never guess" rule applies here
      // too, so a missing total is not itself a defect; only a missing "1 failed" is a hard
      // failure. Presence or correct omission of the total is reported as a finding either way.
      if (!panelHeaderInfo.metaText || !panelHeaderInfo.metaText.includes('1 failed')) {
        failures.push(`Subagents panel's own bash group header meta text is "${panelHeaderInfo.metaText}", expected it to contain "1 failed", matching the main transcript's own grammar.`);
      } else if (/\d+(\.\d+)?(ms|s)$/.test(panelHeaderInfo.metaText)) {
        findings.push(`Subagents panel's own bash group header meta text reads "${panelHeaderInfo.metaText}" (failed count and total time, same grammar as the main transcript).`);
      } else {
        findings.push(`Subagents panel's own bash group header meta text reads "${panelHeaderInfo.metaText}" (failed count shown; total time correctly omitted here per M6's own "every member needs a duration" rule, not independently re-verified for the subagent's own tool items by this script).`);
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '05-turn-e-subagents-panel.png'));

    // ---- Turn (f): hostile output renders inert, bounded ----
    await cdp.typeIntoByLabel('Message', TURN_F_PROMPT);
    // Gate round 2 (Main, D9): whether `Input.insertText` preserves a raw ESC byte through the
    // `<textarea>` is a fact about this TOOL, not #632 -- recorded honestly; the checks below
    // rely only on the X run either way.
    const typedEscSurvived = await cdp.evaluate(`(() => { const el = document.querySelector('[aria-label="Message"]'); return el ? /\\x1b/.test(el.value ?? '') : null; })()`);
    findings.push(`Turn (f): Input.insertText ${typedEscSurvived ? 'preserved' : 'did NOT preserve'} the raw ESC byte in the Message textarea (tool fact, not a #632 finding either way).`);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t632f/g) ?? []).length >= 2; })()`, { timeoutMs: 180_000, label: 'Turn (f) finished' });
    const HOSTILE_RE = /Hostile/;
    const X_RUN_RE = /X{10,}/;
    const hasColourMarkup = (html) => /color\s*:\s*red|style="[^"]*color/i.test(html);
    const noOverflow = (s) => s.transcriptScrollWidth != null && s.transcriptScrollWidth <= s.transcriptClientWidth + 2;
    const isHostile = (text) => HOSTILE_RE.test(text) && X_RUN_RE.test(text);
    // Gate round 2 (Main, D9, High): requires the checked text to actually CONTAIN the hostile
    // output -- the Error line can legitimately show OMP's own exit-code footer instead of the
    // hostile stdout (errorLine()/OMP line-order gap, #650), which has no raw ANSI byte either,
    // so the old check passed VACUOUSLY without ever seeing the hostile content at all.
    const hostileCheck = await cdp.evaluate(`(() => {
      const h = (${GROUP_HEADERS}).at(-1);
      const id = h ? h.getAttribute('aria-describedby') : null;
      const detail = id ? document.getElementById(id) : null;
      if (!detail) return null;
      const t = ${TRANSCRIPT};
      return {
        text: detail.textContent, html: detail.innerHTML, heightPx: detail.getBoundingClientRect().height,
        hasElementChildren: detail.children.length > 0, hasRawAnsiByte: /\\x1b/.test(detail.textContent),
        transcriptScrollWidth: t ? t.scrollWidth : null, transcriptClientWidth: t ? t.clientWidth : null,
      };
    })()`);
    if (!hostileCheck) {
      failures.push('Turn (f) hostile-output call: no Error line (aria-describedby target) found.');
    } else if (!isHostile(hostileCheck.text)) {
      failures.push(`Turn (f) Error line reads ${JSON.stringify(hostileCheck.text)} -- does not contain the hostile output at all (errorLine()/OMP line-order gap, #650), so inert/bounded checks here would be vacuous.`);
    } else if (hostileCheck.hasRawAnsiByte) {
      failures.push(`Turn (f) Error line's own text still contains a raw ANSI escape byte: ${JSON.stringify(hostileCheck.text)}.`);
    } else if (hostileCheck.hasElementChildren) {
      failures.push(`Turn (f) Error line contains injected element(s) instead of plain text: ${hostileCheck.html}.`);
    } else if (hasColourMarkup(hostileCheck.html)) {
      failures.push(`Turn (f) Error line's own markup applies colour styling from the hostile output: ${hostileCheck.html}.`);
    } else if (!(hostileCheck.heightPx > 0 && hostileCheck.heightPx <= 60)) {
      failures.push(`Turn (f) Error line measured ${hostileCheck.heightPx.toFixed(0)}px tall, expected bounded by its own line-clamp-2 cap (<=60px).`);
    } else if (!noOverflow(hostileCheck)) {
      failures.push(`Turn (f) caused the transcript to overflow horizontally (scrollWidth ${hostileCheck.transcriptScrollWidth} > clientWidth ${hostileCheck.transcriptClientWidth}).`);
    } else {
      findings.push(`Turn (f) Error line ("${hostileCheck.text}") genuinely contains the hostile output and renders inert and bounded (${hostileCheck.heightPx.toFixed(0)}px tall, no horizontal overflow).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '06-turn-f-hostile-output.png'));

    // Gate round 2 (Main, D9): the row's own SUMMARY span (`commandRowText`) carries the raw
    // command, including the ×250 X run -- unlike the Error line, OMP's own ARGS transcript
    // reliably carries it, checked both collapsed (truncates) and expanded (must wrap).
    const readSummaryState = `(() => {
      const h = (${GROUP_HEADERS}).at(-1);
      const s = h ? h.querySelector('span.min-w-0.flex-1') : null;
      if (!s) return null;
      const t = ${TRANSCRIPT};
      return {
        text: s.textContent, html: s.innerHTML, hasElementChildren: s.children.length > 0,
        whiteSpace: getComputedStyle(s).whiteSpace,
        transcriptScrollWidth: t ? t.scrollWidth : null, transcriptClientWidth: t ? t.clientWidth : null,
      };
    })()`;
    function assertSummaryState(state, when) {
      if (!state) return failures.push(`Turn (f) ${when}: could not find the hostile call's own summary span.`);
      if (!isHostile(state.text)) return failures.push(`Turn (f) ${when}: summary span reads ${JSON.stringify(state.text)} -- does not contain the hostile output, this check would be vacuous.`);
      if (state.hasElementChildren) failures.push(`Turn (f) ${when}: summary span contains injected element(s): ${state.html}.`);
      else if (hasColourMarkup(state.html)) failures.push(`Turn (f) ${when}: summary span's own markup applies colour styling: ${state.html}.`);
      else if (!noOverflow(state)) failures.push(`Turn (f) ${when}: caused the transcript to overflow horizontally (scrollWidth ${state.transcriptScrollWidth} > clientWidth ${state.transcriptClientWidth}).`);
      else findings.push(`Turn (f) ${when}: summary span genuinely contains the hostile output, renders inert and bounded (computed white-space "${state.whiteSpace}").`);
    }
    assertSummaryState(await cdp.evaluate(readSummaryState), 'collapsed');
    await cdp.click(`(${GROUP_HEADERS}).at(-1)`);
    await cdp.waitFor(`(${GROUP_HEADERS}).at(-1).getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Turn (f) hostile call expanded' });
    const summaryExpanded = await cdp.evaluate(readSummaryState);
    assertSummaryState(summaryExpanded, 'expanded');
    if (!summaryExpanded || summaryExpanded.whiteSpace !== 'normal') {
      failures.push(`Turn (f) expanded: summary span computed white-space is "${summaryExpanded?.whiteSpace}", expected "normal" (wraps the ×250 X run).`);
    } else {
      findings.push('Turn (f) expanded: summary span computed white-space is "normal" -- the ×250 X run wraps instead of overflowing.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '07-turn-f-hostile-output-expanded.png'));

    // Gate round 1 (test-reviewer High, M7): a genuine skip must fail the run, not be silently
    // reported as a footnote -- otherwise a drifted selector could stop testing a real acceptance
    // criterion forever while every run still prints DONE.
    const hasNotExercised = notExercised.length > 0;
    const exitCode = failures.length > 0 || hasNotExercised ? 1 : 0;
    const report = {
      gitHead: gitHeadSha,
      dirty: dirtyFlag,
      exeSha256: exeHash,
      scriptSha256: sha256OfFile(fileURLToPath(import.meta.url)),
      findings,
      failures,
      notExercised,
      exitCode,
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-632: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-632: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-632: NOT EXERCISED (genuine skips only; any entry here fails the run) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-632: ${exitCode !== 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = exitCode;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, dirty: dirtyFlag, exeSha256: exeHash, scriptSha256: sha256OfFile(fileURLToPath(import.meta.url)), findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-632: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch((err) => {
        console.error('verify-632: stopLauncher failed:', err?.stack ?? err);
      });
    }
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-632: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
