#!/usr/bin/env node
// Live CDP check for #2005: sessions.openPersonalAgent is idempotent and worktree-free, the Personal Agent
// launches (and relaunches through startNew) in the home folder with --cwd, a Project Session is unchanged.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-2005.mjs
// Env: REFRACT_2005_SHOTS_DIR overrides the evidence directory.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFreePort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, buildAndCopyExeFresh } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe, buildOmpShim, connectCdp, worktreesDirFor } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-2005';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_2005_SHOTS_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/lane-2005/evidence';

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

const norm = (p) => path.resolve(p).toLowerCase();
const invocations = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => / argv=\[/.test(l) && l.includes('rpc-ui'))
        .map((l) => ({ argv: JSON.parse(l.match(/argv=(\[.*\]) cwd=/)[1]), cwd: l.slice(l.indexOf(' cwd=') + 5) }))
    : [];

async function call(cdp, expr) {
  return cdp.evaluate(`${expr}.then((r) => r)`);
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const scratch = (label) => mkdtempSync(path.join(os.tmpdir(), `refract-2005-${label}-`));
  const [dataDir, importSourceDir, repoDirBase, exeDir, launcherDir, shimDir] = ['data', 'import', 'repo', 'exe', 'launcher', 'shim'].map(scratch);
  const repoDir = makeScratchRepo(repoDirBase, 'verify-2005');
  const worktreesDir = worktreesDirFor(repoDir);
  const debugLog = path.join(exeDir, 'fake-omp-invocations.log');
  const dirs = [dataDir, importSourceDir, repoDirBase, worktreesDir, exeDir, launcherDir, shimDir];
  const home = os.homedir();
  let cdp;
  let child;
  try {
    const launcherExe = buildLauncher(launcherDir);
    buildOmpShim(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: built.hash, builtDuringThisRun: built.builtDuringThisRun } });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, built.dest, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLog
      }
    });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);
    await cdp.waitFor(`!!window.refract?.sessions`, { timeoutMs: 60_000, label: 'bridge ready' });
    await sleep(3_000);

    // a. idempotent open
    const first = await call(cdp, `window.refract.sessions.openPersonalAgent()`);
    const second = await call(cdp, `window.refract.sessions.openPersonalAgent()`);
    const registry = JSON.parse(readFileSync(path.join(dataDir, 'registry.json'), 'utf8'));
    const personalRows = registry.sessions.filter((s) => s.kind === 'personal');
    check(first.ok && second.ok && first.value.id === second.value.id && personalRows.length === 1 && personalRows[0].id === first.value.id && registry.sessions.length === 1, 'a. two opens return one id; registry.json has exactly one personal row', { first: first.value?.id, second: second.value?.id, rows: registry.sessions.length, name: first.value?.name });
    const id = first.value.id;
    writeFileSync(path.join(SHOTS_DIR, 'registry-after-open.json'), JSON.stringify(registry, null, 2));

    // b. no worktree
    const row = personalRows[0];
    check(row.worktreePath == null && row.branch == null && row.repositoryId == null && !existsSync(worktreesDir), 'b. no worktree path stored and no worktree folder exists', { worktreePath: row.worktreePath ?? null, worktreesDirExists: existsSync(worktreesDir), dataDirEntries: readdirSync(dataDir) });

    // c. start
    const opened = await call(cdp, `window.refract.sessions.open(${JSON.stringify(id)}, true)`);
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && ['idle','working','needs-you'].includes(r.value.find((s) => s.id === ${JSON.stringify(id)})?.status))`, { timeoutMs: 60_000, label: 'Personal Agent running' });
    const status1 = await call(cdp, `window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(id)}))`);
    const run1 = invocations(debugLog);
    check(opened.ok && run1.length === 1 && norm(run1[0].cwd) === norm(home) && run1[0].argv.includes(`--cwd=${home}`) && status1.status !== 'stopped', 'c. first start: process cwd is the home folder, --cwd=<home> passed, started (no worktree-missing)', { home, run: run1, status: status1.status, openError: opened.error });

    // d. message and reply
    const sent = await call(cdp, `window.refract.chat.send(${JSON.stringify(id)}, 'hello from the personal agent')`);
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(id)})?.status === 'needs-you')`, { timeoutMs: 30_000, label: 'tool approval prompt' });
    const snap0 = await call(cdp, `window.refract.sessions.open(${JSON.stringify(id)})`);
    const pending = JSON.stringify(snap0.value).match(/"requestId":"([^"]+)"|"id":"(dlg-1)"/);
    await call(cdp, `window.refract.chat.answer(${JSON.stringify(id)}, 'dlg-1', { approve: true, option: 'Approve' })`);
    await cdp.waitFor(`window.refract.sessions.open(${JSON.stringify(id)}).then((r) => JSON.stringify(r.value).includes('xyzzy9'))`, { timeoutMs: 30_000, label: 'recorded reply in transcript' });
    const snap1 = await call(cdp, `window.refract.sessions.open(${JSON.stringify(id)})`);
    writeFileSync(path.join(SHOTS_DIR, 'snapshot-after-reply.json'), JSON.stringify(snap1.value, null, 2));
    check(sent.ok && JSON.stringify(snap1.value).includes('xyzzy9') && JSON.stringify(snap1.value).includes('hello from the personal agent'), 'd. a sent message gets the recorded reply (xyzzy9)', { sendOk: sent.ok, pendingSeen: !!pending });

    // e. stop and start again through startNew (start_with_conversation)
    const stop = await call(cdp, `window.refract.sessions.stopAgent(${JSON.stringify(id)})`);
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(id)})?.status === 'stopped')`, { timeoutMs: 30_000, label: 'stopped' });
    const restart = await call(cdp, `window.refract.conversations.startNew(${JSON.stringify(id)})`);
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && ['idle','working','needs-you'].includes(r.value.find((s) => s.id === ${JSON.stringify(id)})?.status))`, { timeoutMs: 60_000, label: 'restarted' });
    const run2 = invocations(debugLog);
    const last = run2[run2.length - 1];
    check(stop.ok && restart.ok && run2.length === 2 && norm(last.cwd) === norm(home) && last.argv.includes(`--cwd=${home}`), 'e. stop then startNew (start_with_conversation): relaunch still has home cwd and --cwd', { run: last, total: run2.length, restartError: restart.error });

    // e2. attachments and the advisor roster resolve the home folder (no not-found for the Personal Agent)
    const probeName = readdirSync(home, { withFileTypes: true }).find((d) => d.isFile() && /^[\w][\w.-]*$/.test(d.name) && statSync(path.join(home, d.name)).size < 100_000)?.name;
    const attached = probeName ? await call(cdp, `window.refract.attachments.readFile(${JSON.stringify(id)}, ${JSON.stringify(probeName)})`) : { ok: false, error: { message: 'no small file in the home folder to attach' } };
    const roster = await call(cdp, `window.refract.advisorRoster.detect(${JSON.stringify(id)})`);
    check(attached.ok && norm(attached.value.path) === norm(path.join(home, probeName)) && roster.ok, 'e2. attachments.readFile resolves a file in the home folder and advisorRoster.detect returns without not-found', { probeName, attached: attached.ok ? { kind: attached.value.kind, path: attached.value.path, byteLength: attached.value.byteLength } : attached.error, roster: roster.ok ? roster.value : roster.error });

    // f. a Project Session is unchanged
    const added = await call(cdp, `window.refract.repositories.add(${JSON.stringify(repoDir)})`);
    const created = added.ok ? await call(cdp, `window.refract.sessions.create({ repositoryId: ${JSON.stringify(added.value.id)}, baseBranch: 'main' })`) : added;
    let projectRun = null;
    if (created.ok) {
      await call(cdp, `window.refract.sessions.open(${JSON.stringify(created.value.id)}, true)`);
      await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && ['idle','working','needs-you'].includes(r.value.find((s) => s.id === ${JSON.stringify(created.value.id)})?.status))`, { timeoutMs: 60_000, label: 'project session running' });
      projectRun = invocations(debugLog)[2];
    }
    const wtPath = created.value?.worktreePath;
    check(created.ok && projectRun && !projectRun.argv.some((a) => a.startsWith('--cwd')) && wtPath && norm(projectRun.cwd) === norm(wtPath) && existsSync(wtPath), 'f. Project Session creates a worktree and launches there with no --cwd', { created: created.ok, error: created.error, worktreePath: wtPath, run: projectRun });
    await cdp.screenshot(path.join(SHOTS_DIR, '01-final-state.png'));
    writeFileSync(path.join(SHOTS_DIR, 'fake-omp-invocations.log'), readFileSync(debugLog, 'utf8').split('\n').filter((l) => / argv=\[/.test(l)).join('\n'));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '99-crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  const failed = report.filter((r) => !r.ok);
  console.log(`${LOG}: ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}; evidence in ${SHOTS_DIR}`);
}

main();
