#!/usr/bin/env node
// Live CDP check for issue #1767 (T056): token guard settings are written to OMP's GLOBAL config, with a backup first.
// Drives the built debug exe (scratch copy) against the REAL `omp` CLI, but with PI_CODING_AGENT_DIR pointed at a scratch
// agent dir (seeded config.yml + models.yml), a scratch REFRACT_DATA_DIR holding a legacy token-guard.json, and a scratch
// Project with its own .omp/config.yml. The real ~/.omp is never read or written.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1767.mjs
// Env: REFRACT_1767_SHOTS_DIR overrides the screenshot/report directory.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, citeScreenshots } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1767';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1767_SHOTS_DIR || path.join(tmpdir(), 'refract-1767-shots');
const MODEL = 'probe-fake/probe-fake-model';
const MODEL2 = 'probe-fake/probe-fake-model-2';
const ORIGINAL_CONFIG = ['task:', '  maxConcurrency: 2', 'modelRoles:', `  default: ${MODEL}`, 'compaction:', '  thresholdPercent: 60', '  thresholdTokens: 50000', ''].join('\n');
const MODELS_YML = ['providers:', '  probe-fake:', '    baseUrl: http://127.0.0.1:1', '    auth: none', '    api: openai-completions', '    models:', '      - id: probe-fake-model', '        name: Probe Fake Model', '        api: openai-completions', '        contextWindow: 200000', '        maxTokens: 1000', '      - id: probe-fake-model-2', '        name: Probe Fake Model 2', '        api: openai-completions', '        contextWindow: 100000', '        maxTokens: 1000', ''].join('\n');
const LEGACY_STORE = { version: 2, overrides: { 'task.maxConcurrency': 3, 'compaction.thresholdPercent': 70, 'compaction.modelThresholds': { [MODEL]: '80%', [MODEL2]: '50%' } }, read_limit_migrated: true, thresholds_reset_pending: false };

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

const navButton = (label) => `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;

/** Runs the real omp against the scratch agent dir only. */
function omp(agentDir, ...args) {
  const result = spawnSync('omp', args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  if (result.status !== 0) throw new Error(`omp ${args.join(' ')} failed: ${result.stderr}`);
  return JSON.parse(result.stdout).value;
}

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    importSourceDir: env.importSourceDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: { PI_CODING_AGENT_DIR: env.agentDir }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function openAdvanced(cdp, repoDir, { registered = false } = {}) {
  // A relaunch already has the Project: Readiness only flashes while it checks, so waiting on its button would hang.
  if (!registered) {
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!document.querySelector('[aria-label="Settings"]') && !!document.querySelector('[data-readiness-primary]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
  }
  await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 30_000, label: 'Settings button' });
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(navButton('Advanced'));
  await cdp.waitFor(`document.body.textContent.includes('File read line limit')`, { timeoutMs: 15_000, label: 'Advanced rendered' });
}

/** The trigger list also covers models of open Sessions: a Session on the second model gives it two rows. */
async function openSessionOnSecondModel(cdp) {
  const repos = await cdp.evaluate(`window.refract.repositories.list()`);
  const created = await cdp.evaluate(`window.refract.sessions.create({ repositoryId: ${JSON.stringify(repos.value[0].id)}, baseBranch: 'main' })`);
  if (!created.ok) throw new Error(`sessions.create failed: ${JSON.stringify(created)}`);
  const id = JSON.stringify(created.value.id);
  await cdp.evaluate(`window.refract.sessions.open(${id})`);
  await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${id})?.status === 'idle')`, { timeoutMs: 60_000, label: 'Session idle' });
  const [provider, modelId] = MODEL2.split('/');
  const set = await cdp.evaluate(`window.refract.model.setModel(${id}, ${JSON.stringify(provider)}, ${JSON.stringify(modelId)})`);
  if (!set.ok) throw new Error(`model.setModel failed: ${JSON.stringify(set)}`);
  await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${id})?.lastModel?.id === ${JSON.stringify(modelId)})`, { timeoutMs: 15_000, label: 'Session reports the second model' });
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.click(navButton('Advanced'));
  await cdp.waitFor(`document.querySelectorAll('ul[aria-labelledby="compaction-triggers-heading"] li').length === 2`, { timeoutMs: 15_000, label: 'two trigger rows' });
}

async function shoot(cdp, name) {
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
}

const backupsIn = (agentDir) => readdirSync(agentDir).filter((n) => n.startsWith('config.yml.refract-backup-'));

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1767-data-'));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'refract-1767-agent-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1767-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1767-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1767-global');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1767-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1767-launcher-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  const dirs = [dataDir, agentDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir];
  let session;
  try {
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: sha256OfFile(exe) } });
    check([exeDir, dataDir, agentDir].every((d) => d.startsWith(tmpdir())), 'Isolation: exe, data dir and OMP agent dir are scratch dirs under the temp dir', { exeDir, dataDir, agentDir });

    writeFileSync(path.join(agentDir, 'config.yml'), ORIGINAL_CONFIG);
    writeFileSync(path.join(agentDir, 'models.yml'), MODELS_YML);
    writeFileSync(path.join(dataDir, 'token-guard.json'), JSON.stringify(LEGACY_STORE, null, 2));
    mkdirSync(path.join(repoDir, '.omp'), { recursive: true });
    writeFileSync(path.join(repoDir, '.omp', 'config.yml'), 'task:\n  maxConcurrency: 4\n');
    const env = { launcherExe, exe, dataDir, importSourceDir, agentDir };

    session = await launch(env);
    const { cdp } = session;
    await openAdvanced(cdp, repoDir);
    await cdp.waitFor(`document.body.textContent.includes('was backed up to')`, { timeoutMs: 30_000, label: 'backup notice rendered' });

    const backups = backupsIn(agentDir);
    check(backups.length === 1 && /^config\.yml\.refract-backup-\d{4}-\d{2}-\d{2}$/.test(backups[0]), 'Backup: exactly one config.yml.refract-backup-YYYY-MM-DD', backups);
    check(backups.length === 1 && readFileSync(path.join(agentDir, backups[0]), 'utf8') === ORIGINAL_CONFIG, 'Backup: holds the config exactly as it was before Refract wrote', backups);
    const noticeText = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="status"]')).map((e) => e.textContent).join(' | ')`);
    check(backups.length === 1 && noticeText.includes(backups[0]), 'Notice: names the backup file', noticeText);

    check(omp(agentDir, 'config', 'get', 'task.maxConcurrency', '--json') === 3, 'Global config: task.maxConcurrency is the token-guard.json choice (3), not the old 2', null);
    check(omp(agentDir, 'config', 'get', 'compaction.thresholdPercent', '--json') === 70, 'Global config: compaction.thresholdPercent is 70', null);
    check(omp(agentDir, 'config', 'get', 'compaction.thresholdTokens', '--json') === -1, 'Global config: compaction.thresholdTokens pinned off (-1)', null);
    const thresholds = omp(agentDir, 'config', 'get', 'compaction.modelThresholds', '--json');
    check(thresholds && thresholds[MODEL] === '80%', 'Global config: compaction.modelThresholds record holds the per-model 80%', thresholds);
    const roles = omp(agentDir, 'config', 'get', 'modelRoles', '--json');
    check(roles && roles.default === MODEL, 'Global config: modelRoles.default is untouched', roles);
    const configText = readFileSync(path.join(agentDir, 'config.yml'), 'utf8');
    check(!/:\s*(null|~)\s*$/m.test(configText), 'Global config: no null entries written', null);

    check(!existsSync(path.join(dataDir, 'token-guard.json')) && existsSync(path.join(dataDir, 'token-guard.json.migrated')), 'token-guard.json is retired (renamed to .migrated)', readdirSync(dataDir));
    check(existsSync(path.join(dataDir, 'token-guard-migration.json')), 'Migration marker written after the full set succeeded', null);

    await openSessionOnSecondModel(cdp);
    const triggerLines = await cdp.evaluate(`Array.from(document.querySelectorAll('ul[aria-labelledby="compaction-triggers-heading"] li')).map((e) => e.textContent)`);
    check(triggerLines.some((l) => l.startsWith(`${MODEL}: `) && /160[,.]?000 tokens \(.*per-model of 200[,.]?000\)/.test(l)), 'Settings > Advanced: trigger line shows 160000 tokens for the per-model threshold of the 200000 window', triggerLines);
    check(triggerLines.length === 2 && triggerLines.some((l) => l.startsWith(`${MODEL2}: `) && /50[,.]?000 tokens \(.*per-model of 100[,.]?000\)/.test(l)), 'Settings > Advanced: a Session on the second model adds its own trigger row (50000 of 100000)', triggerLines);
    const captions = await cdp.evaluate(`Array.from(document.querySelectorAll('h3')).filter((h) => h.textContent === 'Compaction starts at').length`);
    check(captions === 1, 'Settings > Advanced: one visible "Compaction starts at" caption above the trigger rows', captions);
    await cdp.evaluate(`Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === 'Compaction starts at')?.scrollIntoView({ block: 'start' })`);
    await shoot(cdp, 'advanced-two-models.png');
    const labels = await cdp.evaluate(`(() => { const t = document.body.textContent; return { appliesToNew: t.includes('Applies to new Sessions'), projectNote: t.includes("This Project's .omp/config.yml sets this too, so it wins here. Refract does not edit that file."), intro: t.includes("Refract writes these values to OMP's global config") }; })()`);
    check(labels.appliesToNew && labels.projectNote && labels.intro, 'Settings > Advanced: intro, "Applies to new Sessions" and the project-override note render', labels);
    await shoot(cdp, 'advanced-top.png');
    await cdp.evaluate(`(() => { const el = Array.from(document.querySelectorAll('span')).find((e) => e.textContent.startsWith("This Project's .omp/config.yml")); if (el) el.scrollIntoView({ block: 'center' }); })()`);
    await shoot(cdp, 'advanced-project-override.png');

    const setResult = await cdp.evaluate(`window.refract.tokenGuard.set('task.maxConcurrency', 5).then((r) => r.ok)`);
    check(setResult === true && omp(agentDir, 'config', 'get', 'task.maxConcurrency', '--json') === 5, 'A Settings change lands in the global config (task.maxConcurrency 5)', setResult);

    await cdp.evaluate(`document.querySelector('[role="status"]')?.scrollIntoView({ block: 'center' })`);
    await cdp.click(`Array.from(document.querySelectorAll('[role="status"] button')).find((b) => b.textContent.trim() === 'Dismiss')`);
    await cdp.waitFor(`!document.body.textContent.includes('was backed up to')`, { timeoutMs: 10_000, label: 'notice dismissed' });
    // The renderer dismisses optimistically and persists in the background, so wait for the marker before the relaunch.
    const markerFile = path.join(dataDir, 'token-guard-migration.json');
    for (let i = 0; i < 50 && !JSON.parse(readFileSync(markerFile, 'utf8')).noticeDismissed; i++) await sleep(200);
    cdp.close();
    await stopLauncher(session.child).catch(() => {});

    session = await launch(env);
    await openAdvanced(session.cdp, repoDir, { registered: true });
    await session.cdp.waitFor(`!!document.querySelector('ul[aria-labelledby="compaction-triggers-heading"]')`, { timeoutMs: 30_000, label: 'trigger list on relaunch' });
    check(backupsIn(agentDir).length === 1, 'Relaunch: no second backup and no second migration', backupsIn(agentDir));
    check(await session.cdp.evaluate(`!document.body.textContent.includes('was backed up to')`), 'Relaunch: the dismissed backup notice stays gone', null);
    check(omp(agentDir, 'config', 'get', 'task.maxConcurrency', '--json') === 5, 'Relaunch: the global config is not rewritten from the retired file', null);
    await shoot(session.cdp, 'advanced-relaunch.png');
    report.push({ step: 'screenshots (sha256)', ok: true, evidence: citeScreenshots(SHOTS_DIR, shotNames) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
