// #926 launch helper, split into its own module so `verify-926-attach-any-file.mjs` doesn't grow past the file-size cap.
//
// Local launcher, not the shared `verify-tauri-scratch-helpers.mjs` one: that has no `pathPrepend`/`extraEnv` hooks,
// which the fake-omp shim on `PATH` and its `REFRACT_FAKE_OMP_*` env vars need.
import { mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { launchViaJobObject } from './verify-tauri-cdp.mjs';

// `baseEnv` replaces `process.env` as the inherited environment, so a check can launch the app with an allowlist.
export async function launchBuiltExe(launcherExe, exePath, { port, dataDir, pathPrepend, extraEnv = {}, logFile, baseEnv = process.env }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...baseEnv,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    ...extraEnv
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${baseEnv.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}
