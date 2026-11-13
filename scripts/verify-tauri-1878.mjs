#!/usr/bin/env node
// Live CDP check for issue #1878: the composer's role+model pill shows the ROLE (never the model) the moment a
// Session starts and the moment one resumes after a restart; the model name appears only in the tooltip, which
// opens on keyboard focus. Fake omp (the #741 tapes) keeps it off the network. Launch 1 starts a Session whose
// Conversation file is empty (the role must still read Default); launch 2 reopens it with the file naming Slow.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1878_DIR=<evidence dir> node scripts/verify-tauri-1878.mjs

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { openScratchSession } from './verify-741-role-chip-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORK_DIR = process.env.REFRACT_1878_DIR || path.join(tmpdir(), 'r1878');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const PILL = `document.querySelector('[data-role-model-pill]')`;
const SLOW_LINE = JSON.stringify({ type: 'model_change', model: 'github-copilot/claude-fable-5', role: 'slow', resolvedModelIsFallback: false });

const findings = [];
const failures = [];
function check(label, ok, detail) {
  const text = `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`;
  (ok ? findings : failures).push(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
}

/** Reads the pill's visible text, the session's own role and model, then focuses it and reads the tooltip. */
async function inspectPill(cdp, sessionId, expectedRole, shotsDir, prefix) {
  await cdp.waitFor(`!!(${PILL})`, { timeoutMs: 30_000, label: 'role-model pill rendered' });
  // The role arrives from Rust right after launch; give the first paint a fair chance, then record whatever shows.
  await cdp.waitFor(`(${PILL}).textContent.trim() === ${JSON.stringify(expectedRole)}`, { timeoutMs: 15_000, label: `pill reads ${expectedRole}` }).catch(() => {});
  const list = await cdp.evaluate(`window.refract.sessions.list()`);
  const summary = list.ok ? list.value.find((s) => s.id === sessionId) : undefined;
  const text = await cdp.evaluate(`(${PILL}).textContent.trim()`);
  const modelName = summary?.lastModel ? summary.lastModel.name?.trim() || summary.lastModel.id : null;
  check(`${prefix}: Rust reports currentRole ${expectedRole.toLowerCase()}`, summary?.currentRole === expectedRole.toLowerCase(), summary?.currentRole);
  check(`${prefix}: the pill's visible text is the role only`, text === expectedRole, text);
  check(`${prefix}: the pill's visible text does not contain the model name`, modelName !== null && !text.includes(modelName.replace(/^Claude\s+/i, '')), { text, modelName });
  await cdp.screenshot(path.join(shotsDir, `${prefix}-chip.png`));
  await cdp.evaluate(`(${PILL}).focus()`);
  await cdp.waitFor(`!!document.querySelector('[data-slot="tooltip-content"]')`, { timeoutMs: 10_000, label: 'tooltip on focus' }).catch(() => {});
  await sleep(300);
  const tip = await cdp.evaluate(`document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null`);
  check(`${prefix}: the focus tooltip names the model`, !!tip && !!modelName && tip.includes(modelName.replace(/^Claude\s+/i, '')), tip);
  await cdp.screenshot(path.join(shotsDir, `${prefix}-chip-tooltip.png`));
}

async function main() {
  mkdirSync(WORK_DIR, { recursive: true });
  const shotsDir = path.join(WORK_DIR, 'evidence');
  mkdirSync(shotsDir, { recursive: true });
  const base = mkdtempSync(path.join(WORK_DIR, 'run-'));
  const dir = (n) => { const d = path.join(base, n); mkdirSync(d, { recursive: true }); return d; };
  const head = gitHead(REPO_ROOT);
  console.log(`verify-1878: git HEAD ${head}; shots ${shotsDir}`);

  const shim = dir('shim');
  buildOmpShim(shim);
  const launcherExe = buildLauncher(dir('launcher'));
  const built = buildAndCopyExeFresh(dir('exe'), BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1878' });
  const dataDir = dir('data');
  const importDir = dir('import');
  const repoDir = makeScratchRepo(path.join(dir('repo'), 'scratch'), 'verify-1878');
  const conversationFile = path.join(dir('conv'), 'conversation.jsonl');
  writeFileSync(conversationFile, '');

  const launch = async (scenario, name) => {
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port, dataDir, importSourceDir: importDir, pathPrepend: shim, logFile: path.join(base, `${name}.log`),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: scenario,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(base, `${name}-fake-omp.log`)
      }
    });
    const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    return { cdp, child: launched.child };
  };

  let run;
  try {
    run = await launch('role-chip-741', 'start');
    const sessionId = await openScratchSession(run.cdp, repoDir);
    await inspectPill(run.cdp, sessionId, 'Default', shotsDir, '01-start');
    run.cdp.close();
    await stopLauncher(run.child);
    run = undefined;

    // The Conversation file now names Slow; a resumed Session must read it before its first paint settles.
    writeFileSync(conversationFile, SLOW_LINE + '\n');
    run = await launch('role-chip-741-reopen', 'resume');
    await run.cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'session row rendered' });
    await run.cdp.click(`document.querySelector('[data-session-open]')`);
    await run.cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'resumed composer enabled' });
    await inspectPill(run.cdp, sessionId, 'Slow', shotsDir, '02-resume');
  } catch (err) {
    failures.push(`FAIL crash: ${err?.stack ?? err}`);
    console.error(err);
    try { if (run) await run.cdp.screenshot(path.join(shotsDir, 'crash.png')); } catch {}
  } finally {
    if (run) { run.cdp.close(); await stopLauncher(run.child).catch(() => {}); }
  }
  writeFileSync(path.join(shotsDir, 'report.json'), JSON.stringify({ head, findings, failures }, null, 2));
  if (failures.length) {
    console.error(`verify-1878: ${failures.length} FAILURE(S)`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  } else console.log(`verify-1878: ALL ${findings.length} CHECKS PASSED`);
}

main().catch((err) => {
  console.error('verify-1878: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
