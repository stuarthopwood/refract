// Node script behind the PATH `omp` shim for verify-tauri-2002.mjs: forwards every call to the real omp, except that a
// `config set` is failed ("fail" mode: makes the launch migration fail) or held for REFRACT_2002_SET_DELAY_MS ("slow" mode:
// makes the migration retry made by the first save hold its lock for a long time). The mode is the content of the file named by
// REFRACT_2002_MODE_FILE, re-read per call, so the check can switch it while the app runs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === 'config' && args[1] === 'set') {
  let mode = '';
  try {
    mode = readFileSync(process.env.REFRACT_2002_MODE_FILE, 'utf8').trim();
  } catch {}
  if (mode === 'fail') {
    process.stderr.write('verify-tauri-2002: simulated omp config set failure\n');
    process.exit(1);
  }
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, Number(process.env.REFRACT_2002_SET_DELAY_MS || 0)));
}
const result = spawnSync(process.env.REFRACT_2002_REAL_OMP, args, { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
