// Throwaway live-check for lane RM (#454, #740, #741, #762, #766, #760), run once over CDP
// against the already-built debug exe. Isolated `OMP_PROFILE` (never used before, no real
// credentials) so this never touches Stuart's real omp profile; `REFRACT_DATA_DIR`/
// `WEBVIEW2_USER_DATA_FOLDER` are scratch too. Drives every RM channel directly through
// `window.refract.*` (no UI exists for this feature yet, so there is nothing to click).
//
// Root cause of the earlier "start-failed" run (2026-10-14): a brand-new, never-used profile
// has NO default model configured at all, so `omp --mode rpc-ui` exits immediately with "No
// default model selected" before ever emitting a `ready` frame -- confirmed by a direct manual
// repro (same profile, same `--approval-mode=always-ask`, isolated, no app involved). Setting
// `modelRoles.default` to an unreachable selector string is NOT enough on its own: `omp` also
// needs that selector to resolve to a REGISTERED model, so this seeds a `models.yml` defining a
// real (but unreachable) local provider first -- the exact established pattern
// `docs/spike/model-roles-probe.mjs`/`config-watch-role-probe.mjs`/`slash-commands-probe.mjs`
// already use (`probe-fake`/`probe-fake-model`, `baseUrl: http://127.0.0.1:1`).
//
// Usage: node scripts/verify-rm-live-check.mjs (requires CARGO_TARGET_DIR set to the shared
// build cache, or a prior `pnpm tauri build --debug --no-bundle` under `src-tauri/target`; no
// machine-specific fallback path is hardcoded).

import { mkdirSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCdpTarget, CdpSession, launchViaJobObject, stopLauncher } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const PORT = 9381;
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || '.omp';

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

// Same seeded-fake-provider pattern as the committed RM0 probes: a real, registered, but
// unreachable local model, so `omp --mode rpc-ui` has something to resolve at startup. Never
// touches a real provider or spends a real turn; this lane's own checks never send a prompt.
function ensureFakeModel(profile) {
  const agentDir = path.join(homedir(), CONFIG_DIR_NAME, 'profiles', profile, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const yml = [
    'providers:',
    '  probe-fake:',
    '    baseUrl: http://127.0.0.1:1',
    '    auth: none',
    '    api: openai-completions',
    '    models:',
    '      - id: probe-fake-model',
    '        name: Probe Fake Model',
    '        api: openai-completions',
    '        contextWindow: 8000',
    '        maxTokens: 1000',
    '',
  ].join('\n');
  writeFileSync(path.join(agentDir, 'models.yml'), yml);
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
  const exeSrc = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(exeSrc)) {
    throw new Error(
      `built exe not found at ${exeSrc} (CARGO_TARGET_DIR=${CARGO_TARGET_DIR ?? '(unset)'}) -- run ` +
        `CARGO_TARGET_DIR=<shared dir> CARGO_INCREMENTAL=0 pnpm tauri build --debug --no-bundle first`,
    );
  }
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

  const profile = `refract-rm-live-check-${stamp.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`;
  ensureFakeModel(profile);
  // Give the isolated profile a resolvable default (`omp config set modelRoles`, the same CLI
  // path `ipc::model_roles`/`known_role_list` already use) -- `models.yml` alone registers the
  // provider; `modelRoles.default` is what omp's startup check actually reads.
  run('omp', ['--profile', profile, 'config', 'set', 'modelRoles', '{"default":"probe-fake/probe-fake-model"}', '--json']);

  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    // omp's own profile-name charset: `^[a-z0-9][a-z0-9._-]{0,63}$` (lowercase only, confirmed
    // live: an uppercase stamp like `...T07-56...Z` was rejected outright with "Invalid OMP
    // profile").
    OMP_PROFILE: profile,
  };

  const { child } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: exeDir, env });
  const logLines = [];
  child.stdout?.on('data', (d) => logLines.push(d.toString()));
  child.stderr?.on('data', (d) => logLines.push(d.toString()));
  let cdp;
  try {
    await waitForCdpTarget(PORT, { timeoutMs: 60_000 });
    const listResp = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    const page = listResp.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no page target with a debugger URL');
    cdp = await CdpSession.connect(page.webSocketDebuggerUrl);

    await cdp.waitFor(`typeof window.refract === 'object'`, { timeoutMs: 30_000, label: 'window.refract bridge present' });
    record('bridge ready', true);

    // Add the scratch repo, create and open a Session (real omp --mode rpc-ui spawn, isolated
    // profile, the seeded unreachable fake model -- no real credentials, no real turn).
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

    try {
      await cdp.waitFor(
        `window.refract.sessions.list().then(r => r.ok && r.value.find(s => s.id === ${JSON.stringify(sessionId)})?.status === 'idle')`,
        { timeoutMs: 60_000, label: 'Session idle' },
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

    // --- /switch bare (read-only, local) ---
    const switchBareRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/switch')`);
    record('/switch bare', switchBareRes.ok === true, switchBareRes.ok ? undefined : switchBareRes);

    // --- /model bare (rewritten to /switch) ---
    const modelBareRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/model')`);
    record('/model bare (rewritten to /switch)', modelBareRes.ok === true, modelBareRes.ok ? undefined : modelBareRes);

    // --- /switch @<role from cycleOrder>: role alias forward, a LIVE agent ---
    const roles = listRolesRes.ok ? listRolesRes.value.roles.map((r) => r.role) : [];
    const firstRole = roles.find((r) => r !== 'plan') ?? roles[0];
    if (firstRole) {
      const switchRoleRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, ${JSON.stringify(`/switch @${firstRole}`)})`);
      record(`/switch @${firstRole} on a live agent`, switchRoleRes.ok === true, switchRoleRes.ok ? undefined : switchRoleRes);
    } else {
      record('/switch @<role>', false, 'no role available from listRoles to try');
    }

    // --- model.applyRole on a LIVE agent ---
    const secondRole = roles.find((r) => r !== 'plan' && r !== firstRole) ?? firstRole;
    if (secondRole) {
      const applyRoleRes = await cdp.evaluate(`window.refract.model.applyRole(${JSON.stringify(sessionId)}, ${JSON.stringify(secondRole)})`);
      record(`model.applyRole(${secondRole}) on a live agent`, applyRoleRes.ok === true, applyRoleRes.ok ? undefined : applyRoleRes);
    }

    // --- model.setModel on a LIVE agent, with the seeded fake model (the only one this
    // isolated profile has) -- proves the real success path, not only the failure path. ---
    const setModelRes = await cdp.evaluate(`window.refract.model.setModel(${JSON.stringify(sessionId)}, 'probe-fake', 'probe-fake-model')`);
    record('model.setModel(probe-fake/probe-fake-model) on a live agent', setModelRes.ok === true, setModelRes.ok ? undefined : setModelRes);

    // --- model.cycleModel on a LIVE agent (only one catalog model exists on this isolated
    // profile, so this exercises the real RPC round trip; a single-model catalog may report
    // the request itself failed or simply return the same model -- either way, proves the
    // call reaches a live agent and gets a real, well-shaped response, not a crash/hang). ---
    const cycleRes = await cdp.evaluate(`window.refract.model.cycleModel(${JSON.stringify(sessionId)})`);
    record('model.cycleModel on a live agent (well-shaped response)', typeof cycleRes === 'object' && cycleRes !== null, cycleRes);

    // --- model.setModel with a made-up, unresolvable provider/id: the failure path ---
    const badSetModelRes = await cdp.evaluate(
      `window.refract.model.setModel(${JSON.stringify(sessionId)}, 'no-such-provider', 'no-such-model-xyz')`,
    );
    record('model.setModel (unresolvable model, failure path)', badSetModelRes.ok === false, badSetModelRes);
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
  console.log(`isolated profile (left on disk, not deleted): ${path.join(homedir(), CONFIG_DIR_NAME, 'profiles', profile)}`);
  console.log('\n--- app stdout/stderr (tail) ---');
  console.log(logLines.join('').split('\n').slice(-80).join('\n'));
  if (failed.length > 0) process.exitCode = 1;
}

await main();
