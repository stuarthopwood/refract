#!/usr/bin/env node
// Issue #455 quality-gate remediation (gate cycle 2: "commit a probe script like the other
// items", "write down the hashes", "capture raw JSON for add/clear/reject", "record the catalog
// row shape", "correct the env-stripping premise", "probe modelRoleStorage: project"; gate cycle
// 3 LOW, security-auditor: resolve `omp` to an absolute path instead of a bare name, and give
// every call its own dedicated empty scratch cwd instead of inheriting whichever folder this
// script happens to be invoked from; gate cycle 4 MEDIUM, code-reviewer: confirm `config set`
// never writes an ordinary file into that cwd, now that production's `ensureScratchDir` no
// longer checks this itself -- see `main/omp/config.ts`'s own module header for the redesign).
//
// Run: `node docs/spike/model-roles-probe.mjs` (requires `omp` on PATH). Uses a FIXED, literal
// profile name (never computed from Date.now()/random -- this project's own delete-target rule)
// so cleanup at the end is always a hand-typed literal path, never a variable. Never touches the
// real default profile's config.yml; hashes it before and after as the isolation proof. The two
// scratch directories this script creates (the general one every ordinary call runs from, and the
// modelRoleStorage probe's own separate one) are intentionally left on disk afterward with their
// literal paths printed, the same "never auto-delete a probe scratch dir built from a variable"
// convention this project's other probe scripts already follow.
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

// Quality-gate remediation (gate cycle 3 LOW, security-auditor): resolve `omp` to an absolute
// path ONCE, the same discipline the production code's own `resolveExecutable` enforces -- a bare
// `omp` name on Windows searches the spawning process's current folder before PATH, which is
// exactly the hazard that utility exists to close. Windows-only per the project constitution, so
// `where.exe` (never `where` alone, which could resolve to a same-named shell builtin/alias) is
// the right tool here.
async function resolveOmpPath() {
  const { stdout } = await execFileAsync('where.exe', ['omp'], { windowsHide: true });
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) {
    throw new Error('omp not found on PATH (where.exe returned nothing).');
  }
  return first;
}

async function run(ompPath, scratchCwd, args, env) {
  const { stdout } = await execFileAsync(ompPath, ['--profile', PROFILE, ...args], {
    env: env ?? process.env,
    windowsHide: true,
    cwd: scratchCwd,
  });
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

// Quality-gate remediation (gate cycle 4 MEDIUM, code-reviewer): confirms `config set` never
// writes an ordinary file into its own cwd, the assumption the production code's
// `cleanupModelRolesScratchDir` (a plain, non-recursive `fsp.rmdir`) relies on.
async function scratchDirIsEmpty(dir) {
  const entries = await fs.readdir(dir);
  return entries.length === 0;
}

async function main() {
  const results = {};
  const ompPath = await resolveOmpPath();
  // One dedicated, empty scratch cwd for every ordinary call below (quality-gate remediation,
  // gate cycle 3 LOW: these used to run with no `cwd` set at all, inheriting whatever folder the
  // script happened to be invoked from -- a stray `.omp/` there would have been silently merged
  // into every read this script makes). Kept separate from `probeCwd` below, which is its own,
  // deliberately pristine directory the modelRoleStorage probe inspects for a newly-created
  // project `.omp` folder -- reusing this one for that purpose would let one probe's own prior
  // calls taint the very thing the other probe is checking for.
  const scratchCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-probe-scratch-'));

  results.ompVersion = (await execFileAsync(ompPath, ['--version'], { cwd: scratchCwd, windowsHide: true })).stdout.trim();
  results.realConfigBefore = await hashFile(REAL_CONFIG);

  results.baseline = await run(ompPath, scratchCwd, ['config', 'get', 'modelRoles', '--json']);

  results.setOneRole = await run(ompPath, scratchCwd, ['config', 'set', 'modelRoles', '{"task":"anthropic/claude-sonnet-4-5"}', '--json']);
  results.getAfterSetOne = await run(ompPath, scratchCwd, ['config', 'get', 'modelRoles', '--json']);

  results.setTwoRoles = await run(ompPath, scratchCwd, ['config', 'set', 'modelRoles', '{"task":"anthropic/claude-sonnet-4-5","smol":"openai/gpt-4.1-mini"}', '--json']);
  results.getAfterSetTwo = await run(ompPath, scratchCwd, ['config', 'get', 'modelRoles', '--json']);

  results.clearOneKeepOther = await run(ompPath, scratchCwd, ['config', 'set', 'modelRoles', '{"smol":"openai/gpt-4.1-mini"}', '--json']);
  results.getAfterClear = await run(ompPath, scratchCwd, ['config', 'get', 'modelRoles', '--json']);

  results.rejectNonsenseSelector = await run(ompPath, scratchCwd, ['config', 'set', 'modelRoles', '{"smol":"not-a-real-model-xyz"}', '--json']);
  results.getAfterReject = await run(ompPath, scratchCwd, ['config', 'get', 'modelRoles', '--json']);

  // Gate cycle 4 MEDIUM (code-reviewer): proves `config set` leaves nothing behind in its own
  // cwd, confirmed AFTER all four `config set` calls above have run (not just once) -- the
  // production `ensureScratchDir` no longer checks this itself (the module header on
  // `main/omp/config.ts` explains why an `fsp.mkdtemp`-randomised directory needs no check), so
  // this script is now the only place that evidence against the real CLI is recorded.
  results.scratchCwdEmptyAfterFourSetCalls = await scratchDirIsEmpty(scratchCwd);

  // modelRoleStorage: project probe -- does `omp config set modelRoles` honour it, or always
  // write global regardless (as `omp://settings.md`'s own Subcommands table states for `config
  // set` specifically)? `probeCwd` is its own, separate, pristine scratch directory (never
  // `scratchCwd` above -- see that variable's own comment) -- intentionally never recursively
  // deleted by this script (see module header); it starts empty and stays empty in the expected
  // case.
  results.setModelRoleStorageProject = await run(ompPath, scratchCwd, ['config', 'set', 'modelRoleStorage', 'project', '--json']);
  const probeCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-storage-probe-'));
  await execFileAsync(ompPath, ['--profile', PROFILE, 'config', 'set', 'modelRoles', '{"task":"anthropic/claude-sonnet-4-5","smol":"openai/gpt-4.1-mini"}', '--json'], {
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
  await run(ompPath, scratchCwd, ['config', 'reset', 'modelRoleStorage', '--json']);

  // Env-var-effective-value probe: does PI_SMOL_MODEL change what `config get` reports?
  const envWithOverride = Object.assign({}, process.env, { PI_SMOL_MODEL: 'probe/override-xyz' });
  const withEnvOverride = await run(ompPath, scratchCwd, ['config', 'get', 'modelRoles', '--json'], envWithOverride);
  results.envOverrideProbe = { withPiSmolModelSet: withEnvOverride };

  // Catalog row shape (chat kind), on the isolated (credential-less) profile.
  results.catalogIsolated = await run(ompPath, scratchCwd, ['models', '--kind', 'chat', '--json']);

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
