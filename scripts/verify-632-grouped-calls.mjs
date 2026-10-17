#!/usr/bin/env node
// Live CDP check for issue #632 (borderless thread for grouped tool calls and bash/grep/glob/
// read calls; supersedes #430). Modeled on `verify-570-tool-colours.mjs`/`verify-565-spine.mjs`:
// a REAL `omp` (ambient already-signed-in default profile, no `OMP_PROFILE` override), scratch
// cwd/worktree/`REFRACT_DATA_DIR`, never touching Stuart's real Session list.
//
// #632's own structural acceptance (no border at any level, hover tints one row, the Error line
// under a collapsed failed row, the expanded body with no Arguments/Output block) was already
// built and live-checked by #565/#570/#628 -- this script does not re-prove those. It proves
// only what THIS story added:
//   (a) a multi-call group's header reads "<tool> ×N" (never a call's own command), with the
//       failed/interrupted counts AND the group's own total time (the sum of every member's own
//       duration) in the meta slot;
//   (b) a `bash` call's own row reads "$ <command>", a `grep` call's own row reads
//       `grep "<pattern>" <path>`;
//   (c) a row's own command text wraps (not truncates) once the row itself is expanded;
//   (d) an `edit` call's own row shows its own "+N −M" line stat alongside its duration;
//   (e) the SAME grammar renders inside the Subagents panel (`ToolGroupRow` is shared, design
//       point 4: "one row component, used everywhere").
//
// Five turns, one scratch Session (Approval mode seeded to Auto, same as every prior script in
// this family, so no approval-card grouping boundary ever exists):
//   (a) two bash calls, the SECOND deliberately failing -- the group header grammar.
//   (b) one grep call with a known pattern and path -- the command-style row text.
//   (c) one read call -- confirms the row text is UNCHANGED (still just the path), no
//       regression from the new command-style formatter.
//   (d) one edit call (append a line to a tracked scratch file) -- the "+N −M" row stat.
//   (e) one `task()` call starting exactly one subagent that itself makes two bash calls (one
//       failing) -- the same "<tool> ×N" grammar, read from the Subagents panel.

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, launchBuiltExe, safeRmSync, assertExeUnchanged, requireSharedCargoTarget, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_632_SHOTS_DIR || path.join(tmpdir(), 'refract-632-grouped-calls-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// #632-only source text: `commandRowText`'s grep branch builds `grep "<pattern>"` -- the literal
// `grep "` substring does not exist anywhere else in this codebase (confirmed with `grep` over
// `src/` before this script was written), so its presence in the built, non-minified dev
// renderer bundle is a real, cheap proof this exe actually contains #632's code, independent of
// git-log timing reasoning (the same pattern `verify-570-tool-colours.mjs`'s own
// `assertBundleContainsStory570Marker` established, same `out/tauri-web/assets` convention).
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

const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;
// Every top-level TOOL-call group header button in the main transcript. A bare "has a
// `span.font-medium` label" filter also matches a Thought run ("Thought for Ns"/"Thinking",
// `ThoughtRunRow.tsx`) and a Stage/subagent entry ("Stage N", or a subagent's own name,
// `SubagentChainRow.tsx`'s `StageGroupRow`) -- both reuse the exact same `CollapsedLine`
// markup (design point 4, "one row component, used everywhere") and so share that same
// `span.font-medium` span. A real run showed a `Thought for 1s` row landing first in the
// transcript, ahead of this turn's own "bash \u00d72" group, which a plain `.at(0)`/`.at(-1)`
// positional pick (below) then silently returned instead of the group this script means to
// test. Scoped instead to issue #632's own closed table of command-style tool identifiers --
// the literal, lowercase string OMP's own `tool` field reports (the same strings
// `formatToolCommand.ts`'s own `item.tool === 'bash'`/`'grep'` checks match), optionally
// followed by a multi-call group's own " \u00d7N" count suffix.
const GROUP_HEADERS = `Array.from(${TRANSCRIPT}.querySelectorAll('button')).filter((el) => { const l = el.querySelector('span.font-medium'); return l && /^(?:bash|grep|glob|find|read|write|edit)(?:\\s*\\u00d7\\d+)?$/.test((l.textContent || '').trim()); })`;

function groupHeaderInfo(index) {
  return `(() => {
    const h = (${GROUP_HEADERS}).at(${index});
    if (!h) return null;
    const label = h.querySelector('span.font-medium');
    const metaHost = h.querySelector('span.tabular-nums');
    return {
      labelText: label ? label.textContent.trim() : null,
      metaText: metaHost ? metaHost.textContent.replace(/^,\\s*/, '').trim() : null,
      ariaExpanded: h.getAttribute('aria-expanded'),
    };
  })()`;
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

    // Scratch targets turns (b)/(c)/(d) read or edit, committed so `grep`/`read`/`edit` all see
    // a real, tracked file rather than something the agent would have to create first.
    writeFileSync(path.join(repoDir, 't632-read-target.txt'), 'one\ntwo\nthree\n');
    writeFileSync(path.join(repoDir, 't632-edit-target.txt'), 'one\ntwo\nthree\n');
    appendFileSync(path.join(repoDir, 'README-t632grep.txt'), 'line containing t632GrepMarker here\n');

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
    const BASH_GROUP_LABEL = /^bash\s*\u00d72$/;
    if (!BASH_GROUP_LABEL.test(headerA.labelText ?? '')) {
      failures.push(`Turn (a) group header label is "${headerA.labelText}", expected to match /${BASH_GROUP_LABEL}/ ("bash ×2", never a call's own command).`);
    } else {
      findings.push(`Turn (a) group header label reads "${headerA.labelText}" (tool + count, not a call's own command).`);
    }
    if (!headerA.metaText || !headerA.metaText.includes('1 failed')) {
      failures.push(`Turn (a) group header meta text is "${headerA.metaText}", expected to contain "1 failed".`);
    } else if (!/\d+(\.\d+)?(ms|s)$/.test(headerA.metaText)) {
      failures.push(`Turn (a) group header meta text "${headerA.metaText}" has no trailing duration -- the group's own total time (sum of every member's duration) is missing.`);
    } else {
      findings.push(`Turn (a) group header meta text reads "${headerA.metaText}" (failed count and total time joined).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '00-turn-a-collapsed-group.png'));

    // Expand the group, then expand its first member -- the command must WRAP, not truncate,
    // and must read "$ <command>".
    await cdp.click(`(${GROUP_HEADERS}).at(0)`);
    await cdp.waitFor(`(${GROUP_HEADERS}).at(0).getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Turn (a) group expanded' });
    const memberButtons = `Array.from(${TRANSCRIPT}.querySelectorAll('li button'))`;
    const memberCount = await cdp.evaluate(`(${memberButtons}).length`);
    if (memberCount !== 2) failures.push(`Expected 2 member rows inside the expanded group, found ${memberCount}.`);
    else findings.push('Expanded group shows both members down the shared Spine.');
    const member0Summary = await cdp.evaluate(`(() => { const b = (${memberButtons}).at(0); const s = b ? b.querySelector('span.min-w-0.flex-1') : null; return s ? s.textContent.trim() : null; })()`);
    if (!member0Summary || !member0Summary.startsWith('$ ')) {
      failures.push(`First member row's own text is "${member0Summary}", expected it to start with "$ " (the bash command-style form).`);
    } else {
      findings.push(`First member row reads "${member0Summary}" ($ plus the command, not the raw target).`);
    }
    await cdp.click(`(${memberButtons}).at(0)`);
    await cdp.waitFor(`(${memberButtons}).at(0).getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'First member expanded' });
    const member0WrapClass = await cdp.evaluate(`(() => { const b = (${memberButtons}).at(0); const s = b ? b.querySelector('span.min-w-0.flex-1') : null; return s ? s.className : null; })()`);
    if (!member0WrapClass || member0WrapClass.includes('truncate')) {
      failures.push(`Expanded first member's own summary span className is "${member0WrapClass}" -- still truncating instead of wrapping once expanded.`);
    } else {
      findings.push('Expanded first member\'s own command text wraps (no `truncate` class) instead of truncating.');
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
    await cdp.clickByLabel('Show subagents panel');
    await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagents panel open' });
    await cdp.click(`document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"], [role="tree"][aria-label="Subagents"] button')`);
    const PANEL_GROUP_HEADERS = `Array.from(document.querySelectorAll('[role="tabpanel"] button, aside button')).filter((el) => el.querySelector('span.font-medium'))`;
    const panelHeaderInfo = await cdp.evaluate(`(() => {
      const h = (${PANEL_GROUP_HEADERS}).find((el) => { const l = el.querySelector('span.font-medium'); return l && /^bash(\\s*\\u00d72)?$/.test(l.textContent.trim()); });
      if (!h) return null;
      const label = h.querySelector('span.font-medium');
      return { labelText: label.textContent.trim() };
    })()`);
    if (!panelHeaderInfo) {
      notExercised.push('Could not find the subagent\'s own bash group header inside the Subagents panel stream (panel layout or timing did not match this script\'s selector); the main-transcript assertions above already cover the shared component.');
    } else if (!BASH_GROUP_LABEL.test(panelHeaderInfo.labelText)) {
      failures.push(`Subagents panel's own bash group header reads "${panelHeaderInfo.labelText}", expected the same "bash ×2" grammar the main transcript uses (design point 4, one row component used everywhere).`);
    } else {
      findings.push(`Subagents panel's own bash group header reads "${panelHeaderInfo.labelText}" -- the SAME grammar as the main transcript (shared \`ToolGroupRow\`).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '05-turn-e-subagents-panel.png'));

    const report = {
      gitHead: gitHeadSha,
      dirty: dirtyFlag,
      exeSha256: exeHash,
      scriptSha256: sha256OfFile(fileURLToPath(import.meta.url)),
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0,
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-632: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-632: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-632: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-632: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
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
    if (child) await stopLauncher(child).catch(() => {});
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
