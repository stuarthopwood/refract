// Stands in for `omp` (via verify-tauri-omp-shim.exe): runs the REAL omp binary against a scratch HOME and profile,
// passing frames through line by line while teeing each to a wire log.
// It also lets the driver ask omp a question Refract does not: every `inject-*.json` file dropped in
// REFRACT_1835_INJECT_DIR is sent to omp as one command (id must start "verify-"); the response is logged and never
// forwarded, so Refract's own request/response pairing is undisturbed.
// Env: REFRACT_1835_OMP_EXE, REFRACT_1835_OMP_HOME, REFRACT_1835_WIRE_LOG, REFRACT_1835_MODEL, REFRACT_1835_PROFILE, REFRACT_1835_INJECT_DIR.
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const { REFRACT_1835_OMP_EXE: exe, REFRACT_1835_OMP_HOME: home, REFRACT_1835_WIRE_LOG: wireLog, REFRACT_1835_MODEL: model, REFRACT_1835_PROFILE: profile, REFRACT_1835_INJECT_DIR: injectDir } = process.env;
if (!exe || !home || !wireLog || !model || !profile || !injectDir) {
  console.error('verify-tauri-1835-omp-wrapper: missing REFRACT_1835_* environment');
  process.exit(1);
}

const args = process.argv.slice(2);
const isRpc = args.includes('rpc-ui');
if (isRpc) args.push('--model', model);

// Why: scratch HOME alone leaves COPILOT_HOME/APPDATA pointing at real data, and real credentials must not reach the child.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|KEY/i.test(k)));
const child = spawn(exe, args, {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), COPILOT_HOME: path.join(home, 'copilot'), OMP_PROFILE: profile }
});

function wire(dir, frame, extra = {}) {
  // Why: Refract also runs short `omp config get` children through this wrapper; only the RPC process is evidence.
  if (!isRpc) return;
  appendFileSync(wireLog, JSON.stringify({ at: Date.now(), pid: child.pid, dir, frame, ...extra }) + '\n');
}

/** Calls `onLine(line)` for each complete line; the partial tail waits for its newline so a frame is never split. */
function lines(source, onLine) {
  source.setEncoding('utf8');
  let pending = '';
  source.on('data', (data) => {
    pending += data;
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.trim()) onLine(line);
    }
  });
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

lines(child.stdout, (line) => {
  const frame = parse(line);
  // Why: the `task` tool asks permission before spawning; the check is about Pause, not the permission UI, so the
  // wrapper answers it (and hides it from Refract) instead of leaving the turn parked on a dialog.
  if (frame?.type === 'extension_ui_request' && frame.method === 'select' && String(frame.title).startsWith('Allow tool: task')) {
    wire('omp->refract', frame, { autoApproved: true });
    const answer = { type: 'extension_ui_response', id: frame.id, value: 'Approve task for this session' };
    wire('refract->omp', answer, { injected: true });
    child.stdin.write(JSON.stringify(answer) + '\n');
    return;
  }
  const injected = typeof frame?.id === 'string' && frame.id.startsWith('verify-');
  wire('omp->refract', frame, injected ? { injected: true } : {});
  if (!injected) process.stdout.write(line + '\n');
});
lines(process.stdin, (line) => {
  wire('refract->omp', parse(line));
  child.stdin.write(line + '\n');
});
process.stdin.on('end', () => child.stdin.end());

if (isRpc) setInterval(() => {
  let names = [];
  try {
    names = readdirSync(injectDir).filter((n) => /^inject-.*\.json$/.test(n));
  } catch {}
  for (const name of names) {
    const file = path.join(injectDir, name);
    try {
      const command = JSON.parse(readFileSync(file, 'utf8'));
      unlinkSync(file);
      if (command?.type !== 'get_subagents') continue;
      wire('refract->omp', command, { injected: true });
      child.stdin.write(JSON.stringify(command) + '\n');
    } catch {}
  }
}, 150);

child.on('error', (err) => {
  console.error(`verify-tauri-1835-omp-wrapper: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
