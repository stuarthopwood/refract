// Throwaway live-check for lane RM (#454, #740, #741, #762, #766, #760), run once over CDP
// against the already-built debug exe. Isolated `OMP_PROFILE` (never used before, no real
// credentials) so this never touches Stuart's real omp profile; `REFRACT_DATA_DIR`/
// `WEBVIEW2_USER_DATA_FOLDER` are scratch too. Drives every RM channel directly through
// `window.refract.*` (no UI exists for this feature yet, so there is nothing to click).
//
// Usage: node scripts/verify-rm-live-check.mjs

import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCdpTarget, CdpSession, launchViaJobObject, stopLauncher } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const PORT = 9381;

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  run('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  return out;
}

function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  run('git', ['-C', dir, '-c', 'user.name=verify-rm', '-c', 'user.email=verify-rm@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

async function main() {
  const stamp = nowStamp();
  const scratchRoot = path.join(tmpdir(), `refract-rm-live-check-${stamp}`);
  mkdirSync(scratchRoot, { recursive: true });
  const dataDir = path.join(scratchRoot, 'data');
  const repoDir = path.join(scratchRoot, 'repo');
  const exeDir = path.join(scratchRoot, 'exe');
  mkdirSync(dataDir, { recursive: true });
  makeScratchRepo(repoDir);
  mkdirSync(exeDir, { recursive: true });
  const FALLBACK_EXE = 'C:/Users/shopwood/AppData/Local/Temp/rm-models/refract-tauri.exe';
  const exeSrc = existsSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'))
    ? path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe')
    : FALLBACK_EXE;
  if (!existsSync(exeSrc)) throw new Error(`built exe not found at ${exeSrc} (nor the shared target dir -- rebuild with pnpm tauri build --debug --no-bundle)`);
  const exePath = path.join(exeDir, 'refract-tauri.exe');
  copyFileSync(exeSrc, exePath);
  const webview2DataDir = path.join(exeDir, 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const launcherExe = buildLauncher(path.join(scratchRoot, 'launcher'));
  const pidFile = path.join(exeDir, 'target.pid');

  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' -- ' + JSON.stringify(detail) : ''}`);
  }

  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    // omp's own profile-name charset: `^[a-z0-9][a-z0-9._-]{0,63}$` (lowercase only, confirmed
    // live: an uppercase stamp like `...T07-56...Z` was rejected outright with "Invalid OMP
    // profile").
    OMP_PROFILE: `refract-rm-live-check-${stamp.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`,
  };

  const { child } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: exeDir, env });
  const logLines = [];
  child.stdout?.on('data', (d) => logLines.push(d.toString()));
  child.stderr?.on('data', (d) => logLines.push(d.toString()));
  let cdp;
  try {
    await waitForCdpTarget(PORT, { timeoutMs: 60_000 });
    const listResp = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    console.log('CDP targets:', JSON.stringify(listResp));
    const page = listResp.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no page target with a debugger URL');
    cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
    const diag = await cdp.evaluate(`({ title: document.title, href: location.href, hasRefract: typeof window.refract, bodyText: document.body?.innerText?.slice(0, 300) })`);
    console.log('page diag:', JSON.stringify(diag));

    await cdp.waitFor(`typeof window.refract === 'object'`, { timeoutMs: 30_000, label: 'window.refract bridge present' });
    record('bridge ready', true);

    // Add the scratch repo, create and open a Session (real omp --mode rpc-ui spawn, isolated
    // profile, no real credentials).
    const addRes = await cdp.evaluate(`window.refract.repositories.add(${JSON.stringify(repoDir)})`);
    record('repositories.add', addRes.ok === true, addRes.ok ? undefined : addRes);
    if (!addRes.ok) throw new Error('repositories.add failed');
    const repositoryId = addRes.value.id;
    const createRes = await cdp.evaluate(`window.refract.sessions.create({ repositoryId: ${JSON.stringify(repositoryId)}, baseBranch: 'main' })`);
    record('sessions.create', createRes.ok === true, createRes.ok ? undefined : createRes);
    if (!createRes.ok) throw new Error('sessions.create failed');
    const sessionId = createRes.value.id;
    const openRes = await cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(sessionId)})`);
    record('sessions.open', openRes.ok === true, openRes.ok ? undefined : openRes);

    // Wait for the agent to settle to idle (real omp process ready-wait; cold start can be
    // slow on a brand-new, never-used isolated profile, FINDINGS item 6).
    try {
      await cdp.waitFor(
        `window.refract.sessions.list().then(r => r.ok && r.value.find(s => s.id === ${JSON.stringify(sessionId)})?.status === 'idle')`,
        { timeoutMs: 90_000, label: 'Session idle' },
      );
      record('session reached idle', true);
    } catch (err) {
      const diag = await cdp.evaluate(
        `window.refract.sessions.list().then(r => r.ok ? r.value.find(s => s.id === ${JSON.stringify(sessionId)}) : r)`,
      );
      record('session reached idle', false, { error: String(err), diag });
    }

    // --- model.listRoles ---
    const listRolesRes = await cdp.evaluate(`window.refract.model.listRoles(${JSON.stringify(sessionId)})`);
    record('model.listRoles', listRolesRes.ok === true, listRolesRes);

    // --- /plan stays refused ---
    const planRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/plan')`);
    record('/plan refused', planRes.ok === false && planRes.error?.code === 'unknown-command', planRes);

    // --- /models stays refused (never forwarded to OMP) ---
    const modelsRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/models')`);
    record('/models refused', modelsRes.ok === false && modelsRes.error?.code === 'unknown-command', modelsRes);

    // --- /role <unknown> refused locally, before anything is sent to OMP ---
    const badRoleRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/role not-a-real-role-xyz')`);
    record('/role <unknown> refused', badRoleRes.ok === false && badRoleRes.error?.code === 'invalid-argument', badRoleRes);

    // --- /switch bare (read-only, local, should always work) ---
    const switchBareRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/switch')`);
    record('/switch bare', switchBareRes.ok === true, switchBareRes.ok ? undefined : switchBareRes);

    // --- /model bare (rewritten to /switch) ---
    const modelBareRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/model')`);
    record('/model bare (rewritten to /switch)', modelBareRes.ok === true, modelBareRes.ok ? undefined : modelBareRes);

    // --- /switch @<role from cycleOrder> (role alias forward) ---
    const roles = listRolesRes.ok ? listRolesRes.value.roles.map((r) => r.role) : [];
    const firstRole = roles.find((r) => r !== 'plan') ?? roles[0];
    if (firstRole) {
      const applyRoleRes = await cdp.evaluate(`window.refract.model.applyRole(${JSON.stringify(sessionId)}, ${JSON.stringify(firstRole)})`);
      record(`model.applyRole(${firstRole})`, true, applyRoleRes);
    } else {
      record('model.applyRole', false, 'no role available from listRoles to try');
    }

    // --- model.setModel with a made-up provider/id (no real credentials on this isolated
    // profile, so this exercises the failure path: OMP's own 'Model not found' message) ---
    const setModelRes = await cdp.evaluate(
      `window.refract.model.setModel(${JSON.stringify(sessionId)}, 'no-such-provider', 'no-such-model-xyz')`,
    );
    record('model.setModel (unresolvable model, failure path)', setModelRes.ok === false, setModelRes);

    // --- model.cycleModel (no real credentials -> expect a clean failure, not a crash) ---
    const cycleRes = await cdp.evaluate(`window.refract.model.cycleModel(${JSON.stringify(sessionId)})`);
    record('model.cycleModel (no credentials, observes failure shape)', true, cycleRes);
  } catch (err) {
    console.error('verify-rm-live-check: aborted early:', err);
  } finally {
    if (cdp) cdp.close();
    await stopLauncher(child).catch(() => {});
  }

  console.log('\n--- summary ---');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  console.log(`scratch dir (left on disk, not deleted): ${scratchRoot}`);
  console.log('\n--- app stdout/stderr (tail) ---');
  console.log(logLines.join('').split('\n').slice(-80).join('\n'));
  if (failed.length > 0) process.exitCode = 1;
}

await main();
