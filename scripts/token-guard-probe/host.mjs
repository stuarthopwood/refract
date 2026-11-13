// Spawns a real `omp --mode rpc-ui` against scratch directories for the token guard probes (#1935).
// Isolation: PI_CODING_AGENT_DIR, HOME/USERPROFILE/APPDATA and cwd are all scratch; secrets-looking env is dropped.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { modelSelector, modelsYml } from './provider.mjs';

export const OMP_EXE = 'omp';

const ENV_ALLOWLIST = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']);

/**
 * Why: an allowlist, not a denylist, so no real credential in the parent env can reach omp; scratch HOME/agent dir override.
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {{agentDir: string, homeDir: string}} dirs
 */
export function buildChildEnv(parentEnv, { agentDir, homeDir }) {
  const env = Object.fromEntries(Object.entries(parentEnv).filter(([k]) => ENV_ALLOWLIST.has(k.toUpperCase())));
  return Object.assign(env, {
    PI_CODING_AGENT_DIR: agentDir,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
  });
}

export function defaultScratchRoot() {
  return path.join(homedir(), 'refract-1935-probe');
}

/** The real profile dirs a scratch root must never overlap. */
export function realProfileDirs() {
  return [path.join(homedir(), '.omp'), path.join(homedir(), '.pi'), path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'refract-tauri')];
}

export function ompVersion() {
  const r = spawnSync(OMP_EXE, ['--version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : `<omp --version failed: ${r.stderr}>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `a.b.c` lookup in a parsed YAML object. */
export function getDotted(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/** Why: a probe must never touch real config; refuse any dir that is not strictly inside the scratch root. */
function assertInside(root, dir) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing ${dir}: not inside scratch root ${root}`);
}

/** Advisor rosters are forbidden (Stuart, 2026-10-30); fail loudly if one ever appears in a scratch dir. */
export function assertNoRoster(...dirs) {
  for (const dir of dirs) {
    for (const name of ['WATCHDOG.yml', 'WATCHDOG.yaml', 'WATCHDOG.md']) {
      if (existsSync(path.join(dir, name))) throw new Error(`advisor roster file found in ${dir}: ${name}`);
    }
  }
}

function scratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  git(['init', '-q', '-b', 'main']);
  const r = git(['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  if (r.status !== 0) throw new Error(`scratch repo init failed: ${r.stderr}`);
}

/** Spawns omp against scratch dirs; `provider` is the running scripted provider, `files` land in the scratch repo. */
export async function startHost({ label, scratchRoot, provider, config = {}, models, files = {}, configSettleMs = 1500 }) {
  const root = path.resolve(scratchRoot);
  mkdirSync(root, { recursive: true });
  const runDir = mkdtempSync(path.join(root, `${label}-`));
  const agentDir = path.join(runDir, 'agent');
  const homeDir = path.join(runDir, 'home');
  const repoDir = path.join(runDir, 'repo');
  for (const d of [agentDir, homeDir, repoDir]) assertInside(root, d);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  scratchRepo(repoDir);

  const selector = modelSelector((models ?? [{ id: 'probe-model' }])[0].id);
  writeFileSync(path.join(agentDir, 'models.yml'), modelsYml({ port: provider.port, ...(models ? { models } : {}) }));
  const seeded = { ...config, modelRoles: { default: selector, ...(config.modelRoles ?? {}) } };
  writeFileSync(path.join(agentDir, 'config.yml'), yaml.dump(seeded));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(repoDir, rel);
    assertInside(repoDir, target);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  assertNoRoster(agentDir, repoDir);

  const env = buildChildEnv(process.env, { agentDir, homeDir });

  const argv = ['--mode', 'rpc-ui', '--model', selector];
  const child = spawn(OMP_EXE, argv, { cwd: repoDir, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  const stderr = [];
  const waiters = [];
  let pending = '';
  let exited = false;
  let nextId = 1;

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const answerUi = (f) => {
    if (f.method === 'select') {
      const opts = f.options ?? [];
      const pick = opts.find((o) => /approve|allow|yes/i.test(typeof o === 'string' ? o : (o?.label ?? ''))) ?? opts[0];
      send({ type: 'extension_ui_response', id: f.id, value: typeof pick === 'string' ? pick : (pick?.value ?? pick?.label) });
    } else if (f.method === 'confirm') {
      send({ type: 'extension_ui_response', id: f.id, confirmed: true });
    } else if (['input', 'editor', 'ask'].includes(f.method)) {
      send({ type: 'extension_ui_response', id: f.id, cancelled: true });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    pending += data;
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      const record = { at: Date.now(), frame };
      frames.push(record);
      if (frame.type === 'extension_ui_request') answerUi(frame);
      for (const w of [...waiters]) {
        if (w.predicate(record)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(record);
        }
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => stderr.push(d));
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code) => {
      exited = true;
      for (const w of waiters.splice(0)) w.reject(new Error(`omp exited (${code}) while waiting for ${w.label}\n${stderr.join('').slice(-800)}`));
      resolve(code);
    });
  });

  /** Resolves with the first frame record at index >= `from` matching `predicate`. */
  function waitFor(predicate, { from = 0, timeoutMs = 60_000, label: what = 'frame' } = {}) {
    const hit = frames.slice(from).find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(entry), 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}\n${stderr.join('').slice(-800)}`));
      }, timeoutMs);
      const entry = {
        predicate: (rec) => frames.indexOf(rec) >= from && predicate(rec),
        label: what,
        resolve: (rec) => {
          clearTimeout(timer);
          resolve(rec);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      waiters.push(entry);
    });
  }

  await waitFor((r) => r.frame.type === 'ready', { label: 'ready frame', timeoutMs: 60_000 });

  /** Sends a command and resolves with its `response` frame (rejects on `success: false`). */
  async function command(cmd, timeoutMs = 60_000) {
    const id = `probe-${nextId++}`;
    const from = frames.length;
    send({ ...cmd, id });
    const rec = await waitFor((r) => r.frame.type === 'response' && r.frame.id === id, { from, timeoutMs, label: `response to ${cmd.type}` });
    if (rec.frame.success === false) throw new Error(`${cmd.type} failed: ${rec.frame.error}`);
    return rec.frame;
  }

  /** Runs one prompt to `session_settled` and returns the frame index range it produced. */
  async function prompt(message, { timeoutMs = 120_000 } = {}) {
    const from = frames.length;
    const id = `probe-${nextId++}`;
    send({ type: 'prompt', id, message });
    const result = await waitFor((r) => r.frame.type === 'prompt_result' && r.frame.id === id, { from, timeoutMs, label: 'prompt_result' }).catch(async (err) => {
      // Why: builtin slash commands answer with agentInvoked:false on the response and never send prompt_result.
      const resp = frames.slice(from).find((r) => r.frame.type === 'response' && r.frame.id === id);
      if (resp?.frame.data?.agentInvoked === false) return resp;
      throw err;
    });
    const status = result.frame.status;
    if (result.frame.agentInvoked !== false && result.frame.sessionSettled !== true) {
      await waitFor((r) => r.frame.type === 'session_settled', { from, timeoutMs, label: 'session_settled' });
    }
    return { from, to: frames.length, status, records: frames.slice(from) };
  }

  const configPath = path.join(agentDir, 'config.yml');
  const configValue = (key) => getDotted(yaml.load(readFileSync(configPath, 'utf8')) ?? {}, key);

  /** Edits via `omp config set` as Refract does, then waits for config.yml and the file watcher. */
  async function setConfig(key, value) {
    const r = spawnSync(OMP_EXE, ['config', 'set', key, String(value)], { env, cwd: repoDir, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`omp config set ${key} failed: ${r.stderr || r.stdout}`);
    const deadline = Date.now() + 10_000;
    while (String(configValue(key)) !== String(value)) {
      if (Date.now() > deadline) throw new Error(`config.yml never showed ${key}=${value}`);
      await sleep(100);
    }
    await sleep(configSettleMs);
    assertNoRoster(agentDir, repoDir);
  }

  async function stop() {
    if (!exited) {
      child.stdin.end();
      const killer = setTimeout(() => child.kill(), 10_000);
      await exitPromise;
      clearTimeout(killer);
    }
    assertNoRoster(agentDir, repoDir);
  }

  return { runDir, agentDir, repoDir, frames, stderr: () => stderr.join(''), send, waitFor, command, prompt, setConfig, configValue, stop };
}
