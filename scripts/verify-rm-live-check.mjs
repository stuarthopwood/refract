// Throwaway live check for lane RM (#454, #740, #741, #762, #766, #760), run once over CDP against the built debug exe.
// Uses scratch OMP_PROFILE/REFRACT_DATA_DIR/WEBVIEW2_USER_DATA_FOLDER/REFRACT_IMPORT_SOURCE_DIR so Stuart's real data is never touched.
// A fresh omp profile has no default model and exits before `ready`, so a models.yml with an unreachable local provider is seeded first.
//
// Usage: node scripts/verify-rm-live-check.mjs (requires CARGO_TARGET_DIR set to the shared
// build cache; issue #946, no worktree-local src-tauri/target fallback).

import { mkdirSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCdpTarget, CdpSession, launchViaJobObject, stopLauncher } from './verify-tauri-cdp.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
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

// A registered but unreachable local model, so `omp --mode rpc-ui` can resolve a default at startup without a real provider.
function ensureFakeModel(profile) {
  const agentDir = path.join(homedir(), CONFIG_DIR_NAME, 'profiles', profile, 'agent');
  mkdirSync(agentDir, { recursive: true });
  // Distinct models so a role switch is observable; the third id contains a colon (Ollama/Bedrock style) that `selector_matches_model` must not treat as a thinking-level suffix.
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
    '      - id: probe-fake-model-2',
    '        name: Probe Fake Model Two',
    '        api: openai-completions',
    '        contextWindow: 8000',
    '        maxTokens: 1000',
    '      - id: "probe-fake-model:v8"',
    '        name: Probe Fake Model Colon Id',
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
  // Safety (#833): the Electron->Rust import reads Stuart's real %APPDATA%\pinion unless overridden; an empty folder makes it a no-op.
  const importSourceDir = path.join(scratchRoot, 'electron-import-source-empty');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(importSourceDir, { recursive: true });
  makeScratchRepo(repoDir);
  mkdirSync(exeDir, { recursive: true });
  const exeSrc = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(exeSrc)) {
    throw new Error(
      `built exe not found at ${exeSrc} (CARGO_TARGET_DIR=${process.env.CARGO_TARGET_DIR}) -- run ` +
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
  // `models.yml` only registers providers; omp's startup check reads `modelRoles`. smol/slow map to the non-default model so role switches change something.
  run('omp', [
    '--profile',
    profile,
    'config',
    'set',
    'modelRoles',
    '{"default":"probe-fake/probe-fake-model","smol":"probe-fake/probe-fake-model-2","slow":"probe-fake/probe-fake-model-2","vision":"probe-fake/probe-fake-model","myrole":"probe-fake/probe-fake-model-2"}',
    '--json',
  ]);

  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    // Safety (lane R13a, #833): empty, see `importSourceDir`'s own comment above.
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    // omp profile names must match `^[a-z0-9][a-z0-9._-]{0,63}$` (uppercase stamps are rejected).
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

    // --- model.listRoles: exact designed shape, not just `ok` ---
    const listRolesRes = await cdp.evaluate(`window.refract.model.listRoles(${JSON.stringify(sessionId)})`);
    const listRolesRoleNames = listRolesRes.ok ? listRolesRes.value.roles.map((r) => r.role) : [];
    record(
      'model.listRoles returns cycleOrder+plan, each role.model and the pinned/currentRole flags',
      listRolesRes.ok === true
        && listRolesRoleNames.join(',') === 'smol,default,slow,plan'
        && listRolesRes.value.pinned === false
        && listRolesRes.value.currentRole === null
        && listRolesRes.value.roles.find((r) => r.role === 'default')?.model === 'probe-fake/probe-fake-model'
        && listRolesRes.value.roles.find((r) => r.role === 'smol')?.model === 'probe-fake/probe-fake-model-2'
        && listRolesRes.value.roles.find((r) => r.role === 'slow')?.model === 'probe-fake/probe-fake-model-2'
        && listRolesRes.value.roles.find((r) => r.role === 'plan')?.model === null,
      listRolesRes,
    );

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

    // --- /switch @<role from cycleOrder>: asserts the recorded model ids (`smol` -> probe-fake-model-2). ---
    const roles = listRolesRoleNames;
    const firstRole = roles.find((r) => r !== 'plan') ?? roles[0];
    let firstRoleExpectedId;
    if (firstRole) {
      firstRoleExpectedId = listRolesRes.value.roles.find((r) => r.role === firstRole)?.model?.split('/').pop();
      const switchRoleRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, ${JSON.stringify(`/switch @${firstRole}`)})`);
      const afterSwitchList = await cdp.evaluate(`window.refract.sessions.list()`);
      const afterSwitchModel = afterSwitchList.ok ? afterSwitchList.value.find((s) => s.id === sessionId)?.lastModel : undefined;
      record(
        `/switch @${firstRole} on a live agent moves to its configured model (${firstRoleExpectedId})`,
        switchRoleRes.ok === true && afterSwitchModel?.id === firstRoleExpectedId,
        { switchRoleRes, afterSwitchModel },
      );
    } else {
      record('/switch @<role>', false, 'no role available from listRoles to try');
    }

    // --- model.applyRole on a LIVE agent (back to "default") ---
    const secondRole = roles.find((r) => r !== 'plan' && r !== firstRole) ?? firstRole;
    if (secondRole) {
      const applyRoleRes = await cdp.evaluate(`window.refract.model.applyRole(${JSON.stringify(sessionId)}, ${JSON.stringify(secondRole)})`);
      record(`model.applyRole(${secondRole}) on a live agent`, applyRoleRes.ok === true, applyRoleRes.ok ? undefined : applyRoleRes);
    }

    // --- #766: /role <role> switches directly ({queued:false}) and updates currentRole/pinned (#741); "slow" resolves to model 2. ---
    const slowRoleRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/role slow')`);
    const afterSlowList = await cdp.evaluate(`window.refract.sessions.list()`);
    const afterSlowSummary = afterSlowList.ok ? afterSlowList.value.find((s) => s.id === sessionId) : undefined;
    record(
      '/role slow switches directly, returns {queued:false}, and SessionSummary reflects it',
      slowRoleRes.ok === true
        && slowRoleRes.value?.queued === false
        && afterSlowSummary?.pinned === false
        && afterSlowSummary?.currentRole === 'slow'
        && afterSlowSummary?.lastModel?.id === 'probe-fake-model-2',
      { slowRoleRes, afterSlowSummary },
    );

    // --- model.setModel on a LIVE agent; pins the Session (Decision 1). ---
    const setModelRes = await cdp.evaluate(`window.refract.model.setModel(${JSON.stringify(sessionId)}, 'probe-fake', 'probe-fake-model')`);
    record('model.setModel(probe-fake/probe-fake-model) on a live agent', setModelRes.ok === true, setModelRes.ok ? undefined : setModelRes);

    // --- #766/Decision 1: choosing a role again un-pins a pinned Session (pinned confirmed before). ---
    const beforeUnpinList = await cdp.evaluate(`window.refract.sessions.list()`);
    const beforeUnpinPinned = beforeUnpinList.ok ? beforeUnpinList.value.find((s) => s.id === sessionId)?.pinned : undefined;
    const unpinRes = await cdp.evaluate(`window.refract.model.applyRole(${JSON.stringify(sessionId)}, 'smol')`);
    const afterUnpinList = await cdp.evaluate(`window.refract.sessions.list()`);
    const afterUnpinSummary = afterUnpinList.ok ? afterUnpinList.value.find((s) => s.id === sessionId) : undefined;
    record(
      'choosing a role again un-pins a previously pinned Session',
      beforeUnpinPinned === true
        && unpinRes.ok === true
        && afterUnpinSummary?.pinned === false
        && afterUnpinSummary?.currentRole === 'smol',
      { beforeUnpinPinned, unpinRes, afterUnpinSummary },
    );

    // --- model.cycleModel on a LIVE agent: must move to the other seeded model. ---
    const beforeCycleList = await cdp.evaluate(`window.refract.sessions.list()`);
    const beforeCycleModelId = beforeCycleList.ok ? beforeCycleList.value.find((s) => s.id === sessionId)?.lastModel?.id : undefined;
    const cycleRes = await cdp.evaluate(`window.refract.model.cycleModel(${JSON.stringify(sessionId)})`);
    record(
      'model.cycleModel on a live agent succeeds and moves to the other catalog model',
      cycleRes.ok === true && !!cycleRes.value?.model?.id && cycleRes.value.model.id !== beforeCycleModelId,
      { cycleRes, beforeCycleModelId },
    );

    // --- #740 sweep: four Sessions in distinct states, then change "default" and check each bucket (`sessionId` is already pinned, reused as skippedPinned). ---
    async function createSweepSession(label) {
      const createRes = await cdp.evaluate(`window.refract.sessions.create({ repositoryId: ${JSON.stringify(repositoryId)}, baseBranch: 'main' })`);
      if (!createRes.ok) {
        record(`sweep: create (${label})`, false, createRes);
        return null;
      }
      return createRes.value.id;
    }
    async function openAndWaitIdle(id, label) {
      await cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(id)})`);
      try {
        await cdp.waitFor(
          `window.refract.sessions.list().then(r => r.ok && r.value.find(s => s.id === ${JSON.stringify(id)})?.status === 'idle')`,
          { timeoutMs: 60_000, label: `sweep ${label} idle` },
        );
      } catch (err) {
        record(`sweep: ${label} reached idle`, false, String(err));
      }
    }

    const movedId = await createSweepSession('moved candidate');
    if (movedId) await openAndWaitIdle(movedId, 'moved candidate');

    const otherRoleId = await createSweepSession('other-role candidate');
    if (otherRoleId) {
      await openAndWaitIdle(otherRoleId, 'other-role candidate');
      const applyOtherRole = await cdp.evaluate(`window.refract.model.applyRole(${JSON.stringify(otherRoleId)}, 'smol')`);
      record('sweep: other-role candidate moved to smol', applyOtherRole.ok === true, applyOtherRole.ok ? undefined : applyOtherRole);
    }

    const stoppedId = await createSweepSession('stopped candidate');
    // Never `.open()`ed: `model.listRoles` still registers a Stopped agent without starting omp, giving the real `skippedStopped` case.
    if (stoppedId) await cdp.evaluate(`window.refract.model.listRoles(${JSON.stringify(stoppedId)})`);

    const workingId = await createSweepSession('working candidate');
    if (workingId) await openAndWaitIdle(workingId, 'working candidate');

    const namesRes = await cdp.evaluate(`window.refract.sessions.list()`);
    const nameOf = (id) => (namesRes.ok ? namesRes.value.find((s) => s.id === id)?.name : undefined);
    const summaryOf = (id) => (namesRes.ok ? namesRes.value.find((s) => s.id === id) : undefined);
    const pinnedName = nameOf(sessionId);
    const movedName = nameOf(movedId);
    const otherRoleName = nameOf(otherRoleId);
    const stoppedName = nameOf(stoppedId);
    const workingName = nameOf(workingId);
    record(
      "SessionSummary.pinned/currentRole reflect the pinned and other-role candidates' real state",
      summaryOf(sessionId)?.pinned === true && summaryOf(otherRoleId)?.currentRole === 'smol',
      { pinned: summaryOf(sessionId), otherRole: summaryOf(otherRoleId) },
    );

    // --- Decision 1: mid-turn refusal on its own Session; the four calls run concurrently because four sequential round trips outlast the window before the fake model's connection failure ends the turn. ---
    const midTurnId = await createSweepSession('mid-turn candidate');
    if (midTurnId) {
      await openAndWaitIdle(midTurnId, 'mid-turn candidate');
      const midTurnPromise = cdp
        .evaluate(`window.refract.chat.send(${JSON.stringify(midTurnId)}, 'hello')`)
        .catch((err) => ({ ok: false, error: String(err) }));
      // Wait for status `working` (set on OMP's `agent_start`, not on `chat.send`); firing sooner let setModel's atomic check land first on a fast refused turn.
      try {
        await cdp.waitFor(
          `window.refract.sessions.list().then(r => r.ok && r.value.find(s => s.id === ${JSON.stringify(midTurnId)})?.status === 'working')`,
          { timeoutMs: 5_000, label: 'mid-turn candidate working' },
        );
      } catch (err) {
        record('mid-turn candidate reached working status', false, String(err));
      }
      const [midSwitch, midSetModel, midApplyRole, midRole] = await Promise.all([
        cdp.evaluate(`window.refract.chat.send(${JSON.stringify(midTurnId)}, '/switch @smol')`),
        cdp.evaluate(`window.refract.model.setModel(${JSON.stringify(midTurnId)}, 'probe-fake', 'probe-fake-model-2')`),
        cdp.evaluate(`window.refract.model.applyRole(${JSON.stringify(midTurnId)}, 'smol')`),
        cdp.evaluate(`window.refract.chat.send(${JSON.stringify(midTurnId)}, '/role smol')`),
      ]);
      record('mid-turn /switch refused (not-idle)', midSwitch.ok === false && midSwitch.error?.code === 'not-idle', midSwitch);
      record('mid-turn setModel refused (not-idle)', midSetModel.ok === false && midSetModel.error?.code === 'not-idle', midSetModel);
      record('mid-turn applyRole refused (not-idle)', midApplyRole.ok === false && midApplyRole.error?.code === 'not-idle', midApplyRole);
      record('mid-turn /role refused (not-idle)', midRole.ok === false && midRole.error?.code === 'not-idle', midRole);
      await midTurnPromise;
    } else {
      record('mid-turn candidate sessions.create', false, 'could not create the mid-turn Session');
    }

    // Fire a turn without awaiting, then `modelRoles.set` with no call in between, so the role change races a genuinely mid-turn Session.
    const workingTurn = workingId
      ? cdp.evaluate(`window.refract.chat.send(${JSON.stringify(workingId)}, 'hello')`).catch((err) => ({ ok: false, error: String(err) }))
      : null;

    const roleSetRes = await cdp.evaluate(
      `window.refract.modelRoles.set('default', 'probe-fake/probe-fake-model-2')`,
    );
    record('modelRoles.set(default -> probe-fake-model-2) triggers the sweep', roleSetRes.ok === true, roleSetRes.ok ? undefined : roleSetRes);

    if (workingTurn) await workingTurn;

    if (roleSetRes.ok) {
      const p = roleSetRes.value.propagation;
      record('sweep propagation returned', p !== undefined, roleSetRes.value);
      if (p) {
        record(`sweep: moved candidate ('${movedName}') landed in moved`, !!movedName && p.moved.includes(movedName), p);
        record(`sweep: pinned candidate ('${pinnedName}') landed in skippedPinned`, !!pinnedName && p.skippedPinned.includes(pinnedName), p);
        record(
          `sweep: other-role candidate ('${otherRoleName}') is absent from every bucket`,
          !!otherRoleName && !p.moved.includes(otherRoleName) && !p.queued.includes(otherRoleName)
            && !p.skippedPinned.includes(otherRoleName) && !p.skippedStopped.includes(otherRoleName) && !p.failed.includes(otherRoleName),
          p,
        );
        record(`sweep: stopped candidate ('${stoppedName}') landed in skippedStopped`, !!stoppedName && p.skippedStopped.includes(stoppedName), p);
        record(
          `sweep: working candidate ('${workingName}') landed in queued (not failed)`,
          !!workingName && p.queued.includes(workingName) && !p.failed.includes(workingName),
          p,
        );
      }
    }

    // #740's settle-time reapply is not live-checked: the fake provider's retry/backoff outlasts 60s/180s waits and destabilises WebView2,
    // which would misreport an infrastructure failure as a product defect (disclosed in the PR body).

    // --- model.setModel with an unresolvable provider/id: exact failure code and message. ---
    const badSetModelRes = await cdp.evaluate(
      `window.refract.model.setModel(${JSON.stringify(sessionId)}, 'no-such-provider', 'no-such-model-xyz')`,
    );
    record(
      'model.setModel (unresolvable model, failure path)',
      badSetModelRes.ok === false
        && badSetModelRes.error?.code === 'prompt-failed'
        && badSetModelRes.error?.message === 'Model not found: no-such-provider/no-such-model-xyz',
      badSetModelRes,
    );

    // --- #762: /switch <unknown model> leaves `lastModel.id` unchanged (text-command path). ---
    const beforeSwitchUnknownList = await cdp.evaluate(`window.refract.sessions.list()`);
    const beforeSwitchUnknownModelId = beforeSwitchUnknownList.ok
      ? beforeSwitchUnknownList.value.find((s) => s.id === sessionId)?.lastModel?.id
      : undefined;
    const switchUnknownRes = await cdp.evaluate(
      `window.refract.chat.send(${JSON.stringify(sessionId)}, '/switch no-such-provider/no-such-model-xyz')`,
    );
    const afterSwitchUnknownList = await cdp.evaluate(`window.refract.sessions.list()`);
    const afterSwitchUnknownModelId = afterSwitchUnknownList.ok
      ? afterSwitchUnknownList.value.find((s) => s.id === sessionId)?.lastModel?.id
      : undefined;
    record(
      '/switch <unknown model> refused, model left unchanged',
      switchUnknownRes.ok === false
        && switchUnknownRes.error?.code === 'prompt-failed'
        && switchUnknownRes.error?.message?.includes('Model unchanged')
        && !!beforeSwitchUnknownModelId
        && afterSwitchUnknownModelId === beforeSwitchUnknownModelId,
      { switchUnknownRes, beforeSwitchUnknownModelId, afterSwitchUnknownModelId },
    );

    // --- #766: /role validates the wider chat-role set; `smol` stays valid with it removed from `cycleOrder`. ---
    run('omp', ['--profile', profile, 'config', 'set', 'cycleOrder', '["default","slow"]', '--json']);
    const roleSmolId = await createSweepSession('role-smol-validation candidate');
    if (roleSmolId) {
      await openAndWaitIdle(roleSmolId, 'role-smol-validation candidate');
      const roleSmolRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(roleSmolId)}, '/role smol')`);
      record(
        '/role smol validates with smol removed from cycleOrder (known_chat_role_list)',
        roleSmolRes.ok === true && roleSmolRes.value?.queued === false,
        roleSmolRes,
      );
    }

    // --- #766: /switch @<role> uses the same wider list as /role. ---
    const switchSmolId = await createSweepSession('switch-at-smol-validation candidate');
    if (switchSmolId) {
      await openAndWaitIdle(switchSmolId, 'switch-at-smol-validation candidate');
      const switchSmolRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(switchSmolId)}, '/switch @smol')`);
      record(
        '/switch @smol accepted with smol removed from cycleOrder (unified role-validation list)',
        switchSmolRes.ok === true && switchSmolRes.value?.queued === false,
        switchSmolRes,
      );
    }

    // --- #766: a workload role (seeded `vision`) is refused by /role even though configured. ---
    const workloadRoleId = await createSweepSession('workload-role-refusal candidate');
    if (workloadRoleId) {
      await openAndWaitIdle(workloadRoleId, 'workload-role-refusal candidate');
      const workloadRoleRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(workloadRoleId)}, '/role vision')`);
      record(
        '/role vision (a workload role, configured in modelRoles) still refused',
        workloadRoleRes.ok === false && workloadRoleRes.error?.code === 'invalid-argument',
        workloadRoleRes,
      );
    }

    // --- a custom role (`myrole`) with its own `modelRoles` entry is accepted by /role. ---
    const customRoleId = await createSweepSession('custom-role-acceptance candidate');
    if (customRoleId) {
      await openAndWaitIdle(customRoleId, 'custom-role-acceptance candidate');
      const customRoleRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(customRoleId)}, '/role myrole')`);
      record(
        '/role myrole (a genuinely custom modelRoles key) accepted',
        customRoleRes.ok === true && customRoleRes.value?.queued === false,
        customRoleRes,
      );
    }

    // --- re-picking the same colon-id model must be a valid no-op, not truncated to "Model unchanged". ---
    const colonModelId = await createSweepSession('colon-id same-model candidate');
    if (colonModelId) {
      await openAndWaitIdle(colonModelId, 'colon-id same-model candidate');
      const firstColonSwitchRes = await cdp.evaluate(
        `window.refract.chat.send(${JSON.stringify(colonModelId)}, '/switch probe-fake/probe-fake-model:v8')`,
      );
      const afterFirstColonList = await cdp.evaluate(`window.refract.sessions.list()`);
      const afterFirstColonModelId = afterFirstColonList.ok
        ? afterFirstColonList.value.find((s) => s.id === colonModelId)?.lastModel?.id
        : undefined;
      const secondColonSwitchRes = await cdp.evaluate(
        `window.refract.chat.send(${JSON.stringify(colonModelId)}, '/switch probe-fake/probe-fake-model:v8')`,
      );
      record(
        '/switch <same colon-id model> twice: both accepted, model id exactly preserved',
        firstColonSwitchRes.ok === true
          && afterFirstColonModelId === 'probe-fake-model:v8'
          && secondColonSwitchRes.ok === true,
        { firstColonSwitchRes, afterFirstColonModelId, secondColonSwitchRes },
      );
    }
  } catch (err) {
    console.error('verify-rm-live-check: aborted early:', err);
    process.exitCode = 1;
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
