#!/usr/bin/env node
// Live CDP check for #1571 (Usage Project labels): real debug exe, fake omp/gh, scratch
// REFRACT_DATA_DIR and own port. Seeds session files whose cwds are a Project worktree, scratch
// folders, case-duplicate unmatched folders and one cwd-less encoded folder, then asserts the stored
// labels (By project breakdown) and the rendered Usage view show the Project, Other and one merged
// folder row, with the total equal to the seeded sum.

// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1571.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildFakeClis } from './verify-1331-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1571';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(tmpdir(), 'refract-1571-usage');
const PROJECT = 'verify1571proj';
const COST = 0.25;

const line = (value) => `${JSON.stringify(value)}\n`;

/** One session file with one call. `cwd` null writes a header with no cwd (the encoded-folder fallback). */
function writeSession(sessionsDir, folder, id, cwd, ts) {
  const dir = path.join(sessionsDir, folder);
  mkdirSync(dir, { recursive: true });
  const t0 = new Date(ts).toISOString();
  const header = line({ type: 'session', id, timestamp: t0, ...(cwd ? { cwd } : {}) });
  const model = line({ type: 'model_change', id: `${id}m`, timestamp: t0, model: 'github-copilot/claude-sonnet' });
  const message = line({
    type: 'message',
    id: `${id}c`,
    timestamp: t0,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: ts,
      model: 'claude-sonnet',
      provider: 'github-copilot',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: COST / 2, output: COST / 2, cacheRead: 0, cacheWrite: 0, total: COST } }
    }
  });
  writeFileSync(path.join(dir, `${id}.jsonl`), header + model + message);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const failures = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    if (!ok) failures.push(label);
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  };

  const dirs = ['data', 'sessions', 'import', 'exe', 'launcher', 'shim', 'repos'].map((n) => mkdtempSync(path.join(tmpdir(), `refract-1571-${n}-`)));
  const [dataDir, sessionsDir, importSourceDir, exeDir, launcherDir, shimDir, reposDir] = dirs;
  const repoDir = path.join(reposDir, PROJECT);
  let child;
  let cdp;
  const ipc = async (method, ...args) => {
    const r = await cdp.evaluate(`window.refract.usage.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    if (!r || r.ok !== true) throw new Error(`usage.${method} failed: ${JSON.stringify(r)}`);
    return r.value;
  };
  try {
    const now = Date.now() - 60_000;
    // Each session is one call of COST. The worktree sits under <repo>/../pinion-worktrees/<repoName>/.
    const worktreeCwd = path.join(reposDir, 'pinion-worktrees', PROJECT, 'brave-swan');
    const seeded = [
      ['--C--wt--', 'w1', worktreeCwd],
      ['--C--tmp-scratch--', 't1', path.join(tmpdir(), 'verify1571-scratch')],
      ['--C--unregistered-pinion-worktrees-other-a--', 'u1', 'C:\\verify1571\\pinion-worktrees\\other\\a'],
      ['--C--verify1571-Dup--', 'd1', 'C:\\verify1571\\Dup'],
      ['--C--verify1571-dup2--', 'd2', 'C:\\verify1571\\dup'],
      ['--C--verify1571-enc--', 'e1', null]
    ];
    seeded.forEach(([folder, id, cwd], i) => writeSession(sessionsDir, folder, id, cwd, now - i * 1000));
    // Expected stored labels: the Project, one shared Other, one merged Dup row, the encoded folder name.
    const want = new Map([
      [PROJECT, 1],
      ['Other', 2],
      ['Dup', 2],
      ['verify1571-enc', 1]
    ]);

    buildFakeClis(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importSourceDir, REFRACT_OMP_SESSIONS_DIR: sessionsDir, OMP_PROFILE: 'verify1571' }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the process this run launched`);
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'usage api' });

    // Register the Project before the first scan so the worktrees root is in the index.
    mkdirSync(repoDir, { recursive: true });
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repoDir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('commit', '--allow-empty', '-q', '-m', 'init');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'readiness green' });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.clickByText('Local folder…', { tag: '[role="menuitem"]' });
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'repository added' });

    await ipc('start');
    for (let i = 0; i < 100; i++) {
      if ((await ipc('summary', { range: 'all' })).calls >= seeded.length) break;
      await sleep(300);
    }
    const summary = await ipc('summary', { range: 'all' });
    check(summary.calls === seeded.length && Math.abs(summary.spendUsd - COST * seeded.length) < 1e-6, 'total equals the seeded sum', summary);

    const rows = await ipc('breakdown', { range: 'all' }, 'project');
    const got = new Map(rows.map((r) => [r.label, r.calls]));
    check(got.size === want.size && [...want].every(([k, v]) => got.get(k) === v), 'By project rows are the Project, Other, one merged folder and the encoded folder', rows);
    check(![...got.keys()].some((k) => k.toLowerCase().includes('brave-swan') || k.includes('pinion-worktrees') || k.includes('\\')), 'no raw worktree or scratch path is shown as a label', [...got.keys()]);

    // The Usage view and its Project filter read the same stored label.
    await ipc('setPrefs', { filters: { range: 'all', project: null } });
    await cdp.evaluate(`location.reload()`).catch(() => {});
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'reloaded' });
    await cdp.clickByText('Usage');
    await cdp.waitFor(`document.body.innerText.includes('${PROJECT}')`, { timeoutMs: 30_000, label: 'Usage view shows the Project' });
    const text = await cdp.evaluate(`document.body.innerText`);
    check(text.includes('Other') && text.includes('Dup') && !text.includes('brave-swan'), 'rendered Usage view shows Other and the merged folder, not the worktree path');
    await cdp.screenshot(path.join(SHOTS_DIR, '1-usage-by-project.png'));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, failures, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write evidence: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  console.log(`${LOG}: ${failures.length ? `FAILED (${failures.length})` : 'all checks passed'}; evidence in ${SHOTS_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
