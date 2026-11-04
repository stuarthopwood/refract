#!/usr/bin/env node
// Live CDP check for #632: borderless thread for grouped tool calls and bash/grep/glob/read rows.
// Uses a REAL `omp` (ambient signed-in profile) with scratch cwd/worktree/`REFRACT_DATA_DIR`. #565/#570
// already cover the structural acceptance; this proves what #632 added: "<tool> ×N" group headers with
// failed counts and summed time, `$ <command>` / `grep "<pattern>"` row text, edit "+N −M" stats,
// the same grammar in the Subagents panel, single-row hover tint, keyboard focus names, and inert
// bounded rendering of hostile output. Six turns in one scratch Session (Approval mode Auto).

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

// The literal `grep "` substring appears only in #632's `commandRowText`, so its presence in the
// non-minified dev bundle cheaply proves this exe contains #632's code.
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
// A REAL ESC byte (U+001B) in the prompt: `echo` emits it verbatim; a `printf '\033[...'` attempt never reached `item.output`.
const HOSTILE_LONG_LINE = 'X'.repeat(250);
const TURN_F_PROMPT =
  `Make exactly ONE bash tool call that runs exactly this, byte for byte, with no retyping or reinterpreting: \`echo '\x1b[31mHostile\x1b[0m ${HOSTILE_LONG_LINE}'; exit 5\` (deliberately fails; its output has a real ANSI colour escape byte and a very long line). Then reply with exactly the single word 't632f' and nothing else.`;

const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;
// Top-level TOOL-call group header buttons. The label filter excludes Thought runs and Stage entries
// that share `CollapsedLine` markup ("Thought for 1s" once hijacked `.at(0)`); a solo `bash`/`grep` row
// has no label, so it is accepted by its `$ `/`grep "` summary. Buttons inside a Spine `ol.border-l`
// are excluded: an expanded group's member rows match the same label-less fallback.
const GROUP_HEADERS = `Array.from(${TRANSCRIPT}.querySelectorAll('button')).filter((el) => {
  if (el.closest('ol.border-l')) return false;
  const l = el.querySelector('[data-slot="collapsed-line-label"]');
  if (l) return /^(?:Ran|Running|Bash|Searched|Searching|Grep|Find|Glob|Read|Reading|Wrote|Writing|Write|Edited|Editing|Edit)(?:\\s*\\u00d7\\d+)?$/.test((l.textContent || '').trim());
  const s = el.querySelector('span.min-w-0.flex-1');
  const t = s ? (s.textContent || '').trim() : '';
  return /^\\$ /.test(t) || /^grep "/.test(t);
})`;
const BASH_GROUP_LABEL = /^Ran\s*\u00d72$/;

// Also reads the header's SUMMARY span so callers can assert a multi-call group's collapsed header shows no command text.
function groupHeaderInfo(index) {
  return `(() => {
    const h = (${GROUP_HEADERS}).at(${index});
    if (!h) return null;
    const label = h.querySelector('[data-slot="collapsed-line-label"]');
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

    // Targets are COMMITTED: Refract makes a fresh `git worktree` per Session (worktrees.rs), which only
    // has committed content, so an uncommitted file would read "not found".
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
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
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

    // ---- Turn (a): 2 bash calls, #2 fails: the "<tool> ×N" header ----
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
    // The collapsed header's summary span must be empty.
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

    // Hover tints only the hovered row: the Collapsible ROOT (an ancestor of the trigger) must keep
    // the same background while the trigger's changes (#430 regression class).
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

    // Expand the group (the click also gives the header DOM focus).
    await cdp.click(`(${GROUP_HEADERS}).at(0)`);
    await cdp.waitFor(`(${GROUP_HEADERS}).at(0).getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Turn (a) group expanded' });

    // The click gave mouse-acquired focus (no :focus-visible); Tab away then Shift+Tab back forces a keyboard refocus.
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

    // Expanded group (members collapsed) measured against its line-height: about 4 lines, against about 20 before.
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

    // Scoped to THIS group's <ol>, not every <li> in the transcript.
    const memberButtons = `(() => { const h = (${GROUP_HEADERS}).at(0); const root = h ? h.closest('[data-slot="collapsible"]') : null; const ol = root ? root.querySelector('ol.border-l') : null; return ol ? Array.from(ol.querySelectorAll('li button')) : []; })()`;
    const memberCount = await cdp.evaluate(`(${memberButtons}).length`);
    if (memberCount !== 2) failures.push(`Expected 2 member rows inside the expanded group, found ${memberCount}.`);
    else findings.push('Expanded group shows both members down the shared Spine.');

    // Hovering a MEMBER of an expanded group must tint only that member (#430 regression class; the
    // member sits in a different ancestor chain).
    const memberHoverState = `(() => {
      const h = (${GROUP_HEADERS}).at(0);
      const b = (${memberButtons}).at(0);
      if (!h || !b) return null;
      const ancestorBorders = [];
      for (let node = b.parentElement; node && node !== document.body; node = node.parentElement) ancestorBorders.push(getComputedStyle(node).borderTopWidth);
      return { triggerBg: getComputedStyle(h).backgroundColor, ancestorBorders };
    })()`;
    // The expand click leaves the cursor on the header (CDP moves it there); reset off it or its stale hover tint reads as a change.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
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

    // The header's total time must equal the SUM of the member durations.
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

    // Each member's accessible name must include its tool and command.
    const member0Ax = await getAccessibleNameAndRole(cdp, `(${memberButtons}).at(0)`);
    const member1Ax = await getAccessibleNameAndRole(cdp, `(${memberButtons}).at(1)`);
    if (!member0Ax.name || !member0Ax.name.includes('Ran') || !member0Ax.name.includes('t632-one')) {
      failures.push(`First member's own accessible name is "${member0Ax.name}", expected it to include "Ran" and "t632-one".`);
    } else {
      findings.push(`First member's own accessible name includes both tool and command: "${member0Ax.name}".`);
    }
    if (!member1Ax.name || !/^Failed Bash\b/.test(member1Ax.name) || !member1Ax.name.includes('exit 9')) {
      failures.push(`Second member's own accessible name is "${member1Ax.name}", expected it to start "Failed Bash" (a failed call shows its tool name, #1208) and include "exit 9".`);
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
    // Reads the COMPUTED `white-space` and asserts no code-block element and no output text.
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
    // Missing `content` is its own failure: it would otherwise fall through to the clean-expansion finding, a vacuous pass.
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

    // ---- Turn (b): one grep call: `grep "<pattern>" <path>` row text ----
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

    // ---- Turn (c): one read call: row text unchanged (just the path) ----
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

    // ---- Turn (d): one edit call: the "+N −M" stat ----
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

    // ---- Turn (e): the Subagents panel reuses the same grammar ----
    await cdp.typeIntoByLabel('Message', TURN_E_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t632e-done/g) ?? []).length >= 2; })()`, { timeoutMs: 240_000, label: 'Turn (e) finished (subagent done, main agent replied)' });
    // "Show subagents panel" renders only for TWO+ Stages (FR-065), so this single-subagent turn opens
    // the panel via the readout bar's `SubagentsReadout` ("Open subagents panel (1 finished)").
    await cdp.clickByLabel('Open subagents panel', { prefix: true });
    await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagents panel open' });
    await cdp.click(`document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"], [role="tree"][aria-label="Subagents"] button')`);
    // The stream pane has no `[role="tabpanel"]`/`<aside>` wrapper; scope to the `#right-pane-active-panel` host.
    const PANEL_GROUP_HEADERS = `Array.from(document.querySelectorAll('#right-pane-active-panel button')).filter((el) => el.querySelector('[data-slot="collapsed-line-label"]'))`;
    // Polled: a one-shot `evaluate` right after the click raced the stream pane's render in live runs.
    let panelHeaderInfo = null;
    try {
      panelHeaderInfo = await cdp.waitFor(
        `(() => {
          const h = (${PANEL_GROUP_HEADERS}).find((el) => { const l = el.querySelector('[data-slot="collapsed-line-label"]'); return l && /^Ran(\\s*\\u00d72)?$/.test(l.textContent.trim()); });
          if (!h) return null;
          const label = h.querySelector('[data-slot="collapsed-line-label"]');
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
      // Also assert the meta slot's failed count. The subagent group can show no total time ("1 failed"
      // bare; a partial sum is omitted, never guessed), so only a missing "1 failed" is a hard failure.
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
    // Whether `Input.insertText` preserves a raw ESC byte is a fact about the tool, not #632; the checks rely only on the X run.
    const typedEscSurvived = await cdp.evaluate(`(() => { const el = document.querySelector('[aria-label="Message"]'); return el ? /\\x1b/.test(el.value ?? '') : null; })()`);
    findings.push(`Turn (f): Input.insertText ${typedEscSurvived ? 'preserved' : 'did NOT preserve'} the raw ESC byte in the Message textarea (tool fact, not a #632 finding either way).`);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t632f/g) ?? []).length >= 2; })()`, { timeoutMs: 180_000, label: 'Turn (f) finished' });
    const HOSTILE_RE = /Hostile/;
    const X_RUN_RE = /X{10,}/;
    const hasColourMarkup = (html) => /color\s*:\s*red|style="[^"]*color/i.test(html);
    const noOverflow = (s) => s.transcriptScrollWidth != null && s.transcriptScrollWidth <= s.transcriptClientWidth + 2;
    const isHostile = (text) => HOSTILE_RE.test(text) && X_RUN_RE.test(text);
    // The Error line may show OMP's exit-code footer instead of the hostile stdout (out-of-scope
    // errorLine()/OMP line-order gap, #650): recorded as a finding, asserted only when hostile output shows.
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
      findings.push('Turn (f): no Error line (aria-describedby target) found for the hostile-output call -- recorded, not treated as a failure here (see summary-span checks below for the real hostile-content assertion).');
    } else if (!isHostile(hostileCheck.text)) {
      findings.push(`Turn (f) Error line reads ${JSON.stringify(hostileCheck.text)} -- OMP's own line-order choice shows its exit-code footer, not the hostile stdout (errorLine()/OMP line-order gap, #650); recorded as a finding, not asserted pass/fail here.`);
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

    // The row's SUMMARY span carries the raw command incl. the ×250 X run (OMP's ARGS transcript
    // reliably has it): truncated collapsed, wrapped expanded.
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

    // A genuine skip must fail the run: a drifted selector could otherwise stop testing a criterion while every run prints DONE.
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
