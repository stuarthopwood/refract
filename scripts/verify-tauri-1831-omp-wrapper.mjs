// Stands in for `omp` (via verify-tauri-omp-shim.exe): runs the REAL omp binary against a scratch HOME and profile,
// passing stdio through byte for byte while teeing each JSONL frame to a wire log.
// Env: REFRACT_1831_OMP_EXE, REFRACT_1831_OMP_HOME, REFRACT_1831_WIRE_LOG, REFRACT_1831_MODEL, REFRACT_1831_PROFILE.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const { REFRACT_1831_OMP_EXE: exe, REFRACT_1831_OMP_HOME: home, REFRACT_1831_WIRE_LOG: wireLog, REFRACT_1831_MODEL: model, REFRACT_1831_PROFILE: profile } = process.env;
if (!exe || !home || !wireLog || !model || !profile) {
  console.error('verify-tauri-1831-omp-wrapper: missing REFRACT_1831_* environment');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('rpc-ui')) args.push('--model', model);

const child = spawn(exe, args, {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, HOME: home, USERPROFILE: home, OMP_PROFILE: profile }
});

/** Splits a byte stream into lines and logs each parseable JSON line with its direction. */
function tee(source, sink, dir) {
  let pending = '';
  source.on('data', (data) => {
    sink.write(data);
    pending += data.toString('utf8');
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      if (!line) continue;
      let frame = line;
      try {
        frame = JSON.parse(line);
      } catch {}
      appendFileSync(wireLog, JSON.stringify({ at: Date.now(), pid: child.pid, args: args.join(' '), dir, frame }) + '\n');
    }
  });
}

tee(child.stdout, process.stdout, 'omp->refract');
tee(process.stdin, child.stdin, 'refract->omp');
process.stdin.on('end', () => child.stdin.end());
child.on('error', (err) => {
  console.error(`verify-tauri-1831-omp-wrapper: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
