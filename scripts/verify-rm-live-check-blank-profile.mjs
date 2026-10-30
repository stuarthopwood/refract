// Live check: a sparse `modelRoles` profile (only `default`) must not make role checks fail closed.
// Usage: node scripts/verify-rm-live-check-blank-profile.mjs (needs the shared CARGO_TARGET_DIR).

import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCdpTarget, CdpSession, launchViaJobObject, stopLauncher } from './verify-tauri-cdp.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Refuses a worktree-local src-tauri/target (#946).
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const PORT = 9382; // distinct from verify-rm-live-check.mjs's own 9381 -- never run both at once anyway.
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || '.omp';

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

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const stamp = nowStamp();
  const scratchRoot = path.join(tmpdir(), `refract-rm-blank-profile-${stamp}`);
  mkdirSync(scratchRoot, { recursive: true });
  const dataDir = path.join(scratchRoot, 'data');
  const repoDir = path.join(scratchRoot, 'repo');
  const exeDir = path.join(scratchRoot, 'exe');
  const importSourceDir = path.join(scratchRoot, 'electron-import-source-empty');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(importSourceDir, { recursive: true });
  makeScratchRepo(repoDir);
  mkdirSync(exeDir, { recursive: true });
  const exeSrc = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  const exePath = path.join(exeDir, 'refract-tauri.exe');
  copyFileSync(exeSrc, exePath);
  const webview2DataDir = path.join(exeDir, 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const launcherExe = buildLauncher(path.join(scratchRoot, 'launcher'));
  const pidFile = path.join(exeDir, 'target.pid');

  const profile = `refract-rm-blank-profile-${stamp.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`;
  const agentDir = path.join(homedir(), CONFIG_DIR_NAME, 'profiles', profile, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, 'models.yml'),
    [
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
    ].join('\n'),
  );
  // Strip ambient PI_*/OMP_* overrides (e.g. PI_SMOL_MODEL) that would supply roles this
  // script tests the absence of; PI_CONFIG_DIR is re-pinned so the app uses the profile dir written here.
  const filteredParentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PI_') && !key.startsWith('OMP_')),
  );
  const env = {
    ...filteredParentEnv,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    OMP_PROFILE: profile,
    PI_CONFIG_DIR: CONFIG_DIR_NAME,
  };

  // Only `default` is set: omp exits with "No default model selected" without it. cycleOrder stays
  // at OMP's built-in default. Uses the app's filtered env so ambient PI_PROFILE/OMP_PROFILE
  // cannot redirect this call to another profile.
  run(
    'omp',
    [
      '--profile',
      profile,
      'config',
      'set',
      'modelRoles',
      '--json',
      '--',
      JSON.stringify({ default: 'probe-fake/probe-fake-model' }),
    ],
    { env },
  );

  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' -- ' + JSON.stringify(detail) : ''}`);
  }

  const { child } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: exeDir, env });
  const logLines = [];
  child.stdout?.on('data', (d) => logLines.push(d.toString()));
  child.stderr?.on('data', (d) => logLines.push(d.toString()));
  let cdp;
  try {
    const wsUrl = await waitForCdpTarget(PORT, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    await cdp.waitFor(`typeof window.refract === 'object'`, { timeoutMs: 30_000, label: 'window.refract bridge present' });
    record('bridge ready', true);

    const addRes = await cdp.evaluate(`window.refract.repositories.add(${JSON.stringify(repoDir)})`);
    record('repositories.add', addRes.ok === true, addRes.ok ? undefined : addRes);
    if (!addRes.ok) throw new Error('repositories.add failed');
    const repositoryId = addRes.value.id;

    const createRes = await cdp.evaluate(
      `window.refract.sessions.create({ repositoryId: ${JSON.stringify(repositoryId)}, baseBranch: 'main' })`,
    );
    record('sessions.create', createRes.ok === true, createRes.ok ? undefined : createRes);
    if (!createRes.ok) throw new Error('sessions.create failed');
    const sessionId = createRes.value.id;

    await cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(sessionId)})`);
    record('sessions.open', true);
    await cdp.waitFor(
      `window.refract.sessions.list().then(r => r.ok && r.value.find(s => s.id === ${JSON.stringify(sessionId)})?.status === 'idle')`,
      { timeoutMs: 60_000, label: 'session idle' },
    );
    record('session reached idle', true);

    // `vision` is in neither cycleOrder nor modelRoles: refused normally, not a "couldn't read config" failure.
    const visionRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/role vision')`);
    record(
      '/role vision refused normally against a sparse modelRoles record (no couldn\'t-read-config error)',
      visionRes.ok === false && visionRes.error?.code === 'invalid-argument',
      visionRes,
    );

    // `smol` is in cycleOrder's built-in default, so it must validate despite the sparse modelRoles.
    const smolRes = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, '/switch @smol')`);
    record('/switch @smol against a sparse modelRoles record (cycleOrder default alone validates it)', smolRes.ok === true, smolRes);
  } finally {
    if (cdp) cdp.close();
    await stopLauncher(child).catch(() => {});
  }

  console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} passed`);
  console.log(`scratch dir (left on disk, not deleted): ${scratchRoot}`);
  console.log(`isolated profile (left on disk, not deleted): ${path.join(homedir(), CONFIG_DIR_NAME, 'profiles', profile)}`);
  console.log(
    `cleanup hint: every run of this script shares the fixed "refract-rm-blank-profile-*" ` +
      `prefix under both %TEMP% and ~/${CONFIG_DIR_NAME}/profiles -- sweep accumulated runs by ` +
      'that literal glob, never a computed single path.',
  );
  console.log('\n--- app stdout/stderr (tail) ---');
  console.log(logLines.join('').split('\n').slice(-80).join('\n'));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

await main();
