#!/usr/bin/env node
// Live CDP check for #1085 (agent list retention, FR-201 to FR-207). Fixture: scripts/fixtures/omp-frames/stages-1085.jsonl.
// Turn 1 leaves Stage 1 (alpha, finished) and Stage 2 (gamma, a background agent, still running). With the panel open and
// Stage 1's row focused, turn 2 starts: Stage 1 must leave the panel, Stage 2 must stay, the pill must read "1 running",
// the panel must stay open, and focus must land on the panel heading.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.REFRACT_1085_SCRATCH_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/live-1085';
const SHOTS_DIR = process.env.REFRACT_1085_SHOTS_DIR || path.join(SCRATCH, `shots-${Date.now()}`);
const PILL = `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('Open subagents panel'))`;
const TREE_ITEMS = `Array.from(document.querySelectorAll('[role="tree"][aria-label="Subagents"] [role="treeitem"]'))`;
const ITEM_TEXT = `(el) => (el.getAttribute('aria-label') || '') + ' ' + el.innerText`;
const SEND = `document.querySelector('[aria-label="Send message"]')`;

async function main() {
  const findings = [];
  const failures = [];
  const dirs = {};
  const scenarios = [];
  const check = (name, ok, detail) => {
    scenarios.push({ name, ok });
    findings.push(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
    if (!ok) failures.push(`#1085: ${name}: ${detail}`);
  };
  let child, cdp, gitHeadSha = null;
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    for (const n of ['shim', 'data', 'import', 'exe', 'launcher']) dirs[n] = mkdtempSync(path.join(SCRATCH, `${n}-`));
    dirs.repo = makeScratchRepo(mkdtempSync(path.join(SCRATCH, 'repo-')), 'verify-1085');
    const port = await getFreePort();
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1085' });
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stages-1085'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    const repoName = path.basename(dirs.repo);
    await addRepository(cdp, dirs.repo);
    await createSessionViaQuickCreate(cdp, repoName);
    await latestSessionIdAndName(cdp, repoName, []);

    // Turn 1: Stage 1 (alpha, finished) and Stage 2 (gamma, running in the background).
    await cdp.typeIntoByLabel('Message', 'Run two Stages (issue #1085 live check).');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.body.innerText.includes('Turn one done')`, { timeoutMs: 30_000, label: 'turn 1 settled' });
    await cdp.waitFor(`!!(${PILL})`, { timeoutMs: 30_000, label: 'subagents pill mounted' });
    await cdp.clickByLabel('Open subagents panel', { prefix: true });
    await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagents panel open' });
    await cdp.waitFor(`${TREE_ITEMS}.some((el) => /gamma/i.test((${ITEM_TEXT})(el)))`, { timeoutMs: 15_000, label: 'gamma row mounted' });
    const before = await cdp.evaluate(`({ pill: (${PILL}).getAttribute('aria-label'), items: ${TREE_ITEMS}.map(${ITEM_TEXT}) })`);
    findings.push(`before turn 2: ${JSON.stringify(before)}`);
    check('turn 1: both Stages in the panel', /alpha/i.test(before.items.join('|')) && /gamma/i.test(before.items.join('|')), JSON.stringify(before.items));
    check('turn 1: pill reads running', /\(1 running\)/.test(before.pill), before.pill);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '1085-1-before-turn-2.png'));

    // Turn 2: type first, then focus Stage 1's row, then send by a scripted click so focus stays on the row until the prune.
    await cdp.typeIntoByLabel('Message', 'Start the next turn.');
    const focused = await cdp.evaluate(`(() => {
      const row = ${TREE_ITEMS}.find((el) => /alpha/i.test((${ITEM_TEXT})(el)));
      if (!row) return null;
      row.focus();
      return { label: row.getAttribute('aria-label'), active: document.activeElement === row };
    })()`);
    findings.push(`focused Stage 1 row: ${JSON.stringify(focused)}`);
    if (!focused?.active) throw new Error(`could not focus Stage 1's row: ${JSON.stringify(focused)}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '1085-2-stage-1-row-focused.png'));
    await cdp.evaluate(`(${SEND}).click()`);
    await cdp.waitFor(`document.body.innerText.includes('Turn two done.')`, { timeoutMs: 30_000, label: 'turn 2 done' });
    await cdp.waitFor(`!${TREE_ITEMS}.some((el) => /alpha/i.test((${ITEM_TEXT})(el)))`, { timeoutMs: 15_000, label: 'Stage 1 pruned' });
    await new Promise((r) => setTimeout(r, 500));

    const after = await cdp.evaluate(`(() => {
      const pill = ${PILL};
      const active = document.activeElement;
      return {
        pill: pill ? pill.getAttribute('aria-label') : null,
        pillText: pill ? pill.innerText : null,
        treeOpen: !!document.querySelector('[role="tree"][aria-label="Subagents"]'),
        items: ${TREE_ITEMS}.map(${ITEM_TEXT}),
        activeIsHeading: !!active && active.hasAttribute('data-panel-heading'),
        activeDesc: active ? (active.tagName + ' ' + (active.getAttribute('aria-label') || '').slice(0, 60)) : null
      };
    })()`);
    findings.push(`after turn 2: ${JSON.stringify(after)}`);
    check('turn 2: finished Stage gone from the panel', !/alpha/i.test(after.items.join('|')), JSON.stringify(after.items));
    check('turn 2: running Stage stays', /gamma/i.test(after.items.join('|')), JSON.stringify(after.items));
    check('turn 2: pill reads running', /\(1 running\)/.test(after.pill ?? '') && /1 running/.test(after.pillText ?? ''), `${after.pill} / ${after.pillText}`);
    check('turn 2: panel stays open', after.treeOpen, String(after.treeOpen));
    check('turn 2: focus sits on the panel heading', after.activeIsHeading, after.activeDesc ?? 'no active element');
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '1085-3-after-turn-2.png'));

    const passed = scenarios.filter((s) => s.ok).length;
    findings.push(`scenarios: ${passed}/${scenarios.length}`);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, shotsDir: SHOTS_DIR, findings, failures, exitCode: failures.length ? 1 : 0 }, null, 2));
    console.log(JSON.stringify({ findings, failures, shotsDir: SHOTS_DIR }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {}
    console.error('verify-1085: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      if (dirs.exe && existsSync(path.join(dirs.exe, 'app.log'))) copyFileSync(path.join(dirs.exe, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
    } catch {}
    for (const d of Object.values(dirs)) await safeRmSync(d);
  }
}

main();
