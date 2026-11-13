#!/usr/bin/env node
// Live CDP check for issue #1878: the composer's role+model pill shows the ROLE (never the model) the moment a
// Session starts and the moment one resumes after a restart; the model name appears only in the tooltip, which
// opens on keyboard focus (reached by real Tab presses). Fake omp (the #741 tapes) keeps it off the network.
// Launch 1 starts a Session whose Conversation file is empty (the role must still read Default); launch 2 reopens
// it with the file naming Slow. Launch 3 hand-picks a model whose name is far wider than the pill (pin glyph,
// truncation, "Pinned to ..." tooltip). Launch 4 queues a role change mid-turn (clock glyph, new tooltip copy).
// Every capture also reads the pill's name from the AX tree. Usage:
// CARGO_TARGET_DIR=<shared target dir> REFRACT_1878_DIR=<evidence dir> node scripts/verify-tauri-1878.mjs

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { openScratchSession } from './verify-741-role-chip-helpers.mjs';
import { inspectRolePill, inspectPinnedPill, inspectQueuedPill } from './verify-1878-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORK_DIR = process.env.REFRACT_1878_DIR || path.join(tmpdir(), 'r1878');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const CATALOG_FIXTURE = path.join(__dirname, 'fixtures', 'model-catalogs', 'chat-1069.json');
// The queued launch cycles roles with Ctrl+R, so it needs a seeded role list and catalog like the #766b run.
const SEEDED_MODEL_ROLES = {
  default: 'github-copilot/claude-fable-5',
  smol: 'anthropic/claude-haiku-5.5',
  slow: 'anthropic/claude-opus-5.5',
  plan: 'github-copilot/gpt-5.6-terra'
};
const modelChange = (role) => JSON.stringify({ type: 'model_change', model: 'github-copilot/claude-fable-5', role, resolvedModelIsFallback: false });
const SLOW_LINE = modelChange('slow');
const DEFAULT_LINE = modelChange('default');

const findings = [];
const failures = [];
function check(label, ok, detail) {
  const text = `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`;
  (ok ? findings : failures).push(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
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
  const importDir = dir('import');
  const repoDir = makeScratchRepo(path.join(dir('repo'), 'scratch'), 'verify-1878');
  const conversationFile = path.join(dir('conv'), 'conversation.jsonl');
  writeFileSync(conversationFile, '');

  /** Launches 3 and 4 each start from their own empty data dir and Conversation file. */
  const freshLaunch = (name, conversationText) => {
    const file = path.join(dir(`conv-${name}`), 'conversation.jsonl');
    writeFileSync(file, conversationText);
    return { dataDir: dir(`data-${name}`), conversationFile: file };
  };

  const launch = async (scenario, name, { dataDir, conversationFile: conv, extraEnv = {} }) => {
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port, dataDir, importSourceDir: importDir, pathPrepend: shim, logFile: path.join(base, `${name}.log`),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: scenario,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conv,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(base, `${name}-fake-omp.log`),
        REFRACT_FAKE_OMP_HOST_TOOL_RECORD: path.join(dataDir, 'host-tools.jsonl'),
        ...extraEnv
      }
    });
    const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    return { cdp, child: launched.child };
  };
  const finish = async (run) => {
    run.cdp.close();
    await stopLauncher(run.child);
  };

  const startDataDir = dir('data');
  let run;
  try {
    run = await launch('role-chip-741', 'start', { dataDir: startDataDir, conversationFile });
    const sessionId = await openScratchSession(run.cdp, repoDir);
    await inspectRolePill(run.cdp, check, sessionId, 'Default', shotsDir, '01-start');
    await finish(run);
    run = undefined;

    // The Conversation file now names Slow; a resumed Session must read it before its first paint settles.
    writeFileSync(conversationFile, SLOW_LINE + '\n');
    run = await launch('role-chip-741-reopen', 'resume', { dataDir: startDataDir, conversationFile });
    await run.cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'session row rendered' });
    await run.cdp.click(`document.querySelector('[data-session-open]')`);
    await run.cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'resumed composer enabled' });
    await inspectRolePill(run.cdp, check, sessionId, 'Slow', shotsDir, '02-resume');
    await finish(run);
    run = undefined;

    const pinned = freshLaunch('pinned', DEFAULT_LINE + '\n');
    run = await launch('role-pin-1878', 'pinned', pinned);
    const pinnedId = await openScratchSession(run.cdp, repoDir);
    await inspectPinnedPill(run.cdp, check, pinnedId, shotsDir, '03-pinned');
    await finish(run);
    run = undefined;

    const queued = freshLaunch('queued', DEFAULT_LINE + '\n');
    const configStore = path.join(queued.dataDir, 'fake-omp-config-store.json');
    writeFileSync(configStore, JSON.stringify({ modelRoles: SEEDED_MODEL_ROLES, cycleOrder: ['smol', 'default', 'slow'] }));
    run = await launch('role-queued-1878', 'queued', {
      ...queued,
      extraEnv: { REFRACT_FAKE_OMP_CONFIG_STORE: configStore, REFRACT_FAKE_OMP_MODEL_CATALOG: CATALOG_FIXTURE }
    });
    const queuedId = await openScratchSession(run.cdp, repoDir);
    await inspectQueuedPill(run.cdp, check, queuedId, shotsDir, '04-queued');
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
