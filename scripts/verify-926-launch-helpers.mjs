// #926 launch helper, split out of `verify-926-attach-any-file.mjs` (AGENTS.md: an over-cap file
// must never grow; a baseline raise is not an acceptable fix) into its own sibling module, the
// same pattern `verify-926-drag-drop-trap.mjs` already uses.
//
// Local launcher (not the shared `verify-tauri-scratch-helpers.mjs` one): that shared helper has
// no `pathPrepend`/`extraEnv` hooks, needed here for the fake-omp shim on `PATH` and its own
// `REFRACT_FAKE_OMP_*` env vars -- the exact extension `verify-tauri-ask.mjs` already carries.
import { mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { launchViaJobObject } from './verify-tauri-cdp.mjs';

export async function launchBuiltExe(launcherExe, exePath, { port, dataDir, pathPrepend, extraEnv = {}, logFile }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    ...extraEnv
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}
