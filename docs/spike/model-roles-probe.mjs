#!/usr/bin/env node
// Issue #455 quality-gate remediation (gate cycle 2: "commit a probe script like the other
// items", "write down the hashes", "capture raw JSON for add/clear/reject", "record the catalog
// row shape", "correct the env-stripping premise", "probe modelRoleStorage: project").
//
// Run: `node docs/spike/model-roles-probe.mjs` (requires `omp` on PATH). Uses a FIXED, literal
// profile name (never computed from Date.now()/random -- this project's own delete-target rule)
// so cleanup at the end is always a hand-typed literal path, never a variable. Never touches the
// real default profile's config.yml; hashes it before and after as the isolation proof. The one
// scratch directory this script creates (for the modelRoleStorage probe) is intentionally left on
// disk afterward and its literal path printed, the same "never auto-delete a probe scratch dir
// built from a variable" convention this project's other probe scripts already follow.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROFILE = 'refract-scratch-verify-594r3';
const REAL_CONFIG = path.join(os.homedir(), '.omp', 'agent', 'config.yml');
const PROFILE_DIR = path.join(os.homedir(), '.omp', 'profiles', PROFILE);

async function run(args, env) {
  const { stdout } = await execFileAsync('omp', ['--profile', PROFILE, ...args], { env: env ?? process.env, windowsHide: true });
  return stdout.trim();
}

async function hashFile(file) {
  try {
    const data = await fs.readFile(file);
    const stat = await fs.stat(file);
    return { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

async function main() {
  const results = {};

  results.ompVersion = (await execFileAsync('omp', ['--version'])).stdout.trim();
  results.realConfigBefore = await hashFile(REAL_CONFIG);

  results.baseline = await run(['config', 'get', 'modelRoles', '--json']);

  results.setOneRole = await run(['config', 'set', 'modelRoles', '{"task":"anthropic/claude-sonnet-4-5"}', '--json']);
  results.getAfterSetOne = await run(['config', 'get', 'modelRoles', '--json']);

  results.setTwoRoles = await run(['config', 'set', 'modelRoles', '{"task":"anthropic/claude-sonnet-4-5","smol":"openai/gpt-4.1-mini"}', '--json']);
  results.getAfterSetTwo = await run(['config', 'get', 'modelRoles', '--json']);

  results.clearOneKeepOther = await run(['config', 'set', 'modelRoles', '{"smol":"openai/gpt-4.1-mini"}', '--json']);
  results.getAfterClear = await run(['config', 'get', 'modelRoles', '--json']);

  results.rejectNonsenseSelector = await run(['config', 'set', 'modelRoles', '{"smol":"not-a-real-model-xyz"}', '--json']);
  results.getAfterReject = await run(['config', 'get', 'modelRoles', '--json']);

  // modelRoleStorage: project probe -- does `omp config set modelRoles` honour it, or always
  // write global regardless (as `omp://settings.md`'s own Subcommands table states for `config
  // set` specifically)? The scratch cwd below is intentionally never recursively deleted by this
  // script (see module header); it starts empty and stays empty in the expected case.
  results.setModelRoleStorageProject = await run(['config', 'set', 'modelRoleStorage', 'project', '--json']);
  const probeCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-storage-probe-'));
  await execFileAsync('omp', ['--profile', PROFILE, 'config', 'set', 'modelRoles', '{"task":"anthropic/claude-sonnet-4-5","smol":"openai/gpt-4.1-mini"}', '--json'], {
    cwd: probeCwd,
    windowsHide: true,
  });
  let projectOmpCreated = false;
  try {
    await fs.access(path.join(probeCwd, '.omp'));
    projectOmpCreated = true;
  } catch {
    projectOmpCreated = false;
  }
  results.modelRoleStorageProjectProbe = {
    scratchCwdLeftOnDisk: probeCwd,
    projectOmpFolderCreatedInCwd: projectOmpCreated,
    globalConfigYml: await fs.readFile(path.join(PROFILE_DIR, 'agent', 'config.yml'), 'utf8'),
  };
  await run(['config', 'reset', 'modelRoleStorage', '--json']);

  // Env-var-effective-value probe: does PI_SMOL_MODEL change what `config get` reports?
  const envWithOverride = Object.assign({}, process.env, { PI_SMOL_MODEL: 'probe/override-xyz' });
  const withEnvOverride = await run(['config', 'get', 'modelRoles', '--json'], envWithOverride);
  results.envOverrideProbe = { withPiSmolModelSet: withEnvOverride };

  // Catalog row shape (chat kind), on the isolated (credential-less) profile.
  results.catalogIsolated = await run(['models', '--kind', 'chat', '--json']);

  results.realConfigAfter = await hashFile(REAL_CONFIG);
  results.realConfigUnchanged = JSON.stringify(results.realConfigBefore) === JSON.stringify(results.realConfigAfter);

  console.log(JSON.stringify(results, null, 2));
}

main()
  .then(() => {
    console.error('\nDone. Profile directory left on disk for inspection: ' + PROFILE_DIR);
    console.error('Delete it by hand with a literal path when finished.');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
