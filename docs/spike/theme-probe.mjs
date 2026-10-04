// Spec 007 (App themes) T001 gate probe. Two independent Electron/Windows facts, both
// UNVERIFIED in research.md (decisions 4 and 9), checked before any later task assumes them:
//
// (a) A synchronous `ipcRenderer.sendSync('theme:bootstrap', ...)` round trip, called from a
//     preload exposed function invoked by an inline <script> at the very top of <head> (before
//     any paintable content), under this app's real `sandbox: true` + `contextIsolation: true`
//     webPreferences -- confirm it resolves (no throw, no hang) and time the round trip. The
//     window is created with `show: false` and only shown on `ready-to-show` (same pattern as
//     `src/main/index.ts`'s `createWindow`), so the real question is whether the synchronous
//     call itself works at all under sandbox+contextIsolation, not whether a frame leaks before
//     `show()` -- `show: false` already backstops that regardless of this call's timing. The
//     result is also reported back to main through a SECOND preload-exposed function (not
//     `require('electron')` from the page's own script, which is undefined in a sandboxed,
//     context-isolated renderer's main world and would just throw).
// (b) `createHighlighter({ themes: ['github-dark-high-contrast'], langs: [], engine:
//     createJavaScriptRegexEngine() })` at the pinned `shiki@4.4.3` resolves with no error.
//
// Run from the repo root with the project's own Electron binary (same invocation style as
// docs/spike/menu-alt-probe.cjs):
//   node_modules/electron/dist/electron.exe docs/spike/theme-probe.mjs
//
// Writes one JSON object to <repoRoot>/docs/spike/theme-probe-result.json and exits via
// app.quit(). No scratch user-data dir needed: this probe touches no real Refract state.
import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// This harness's bash tool runs Electron in a non-interactive Windows session with no real GPU
// surface; FINDINGS item 24 already found `ready-to-show` never fires there without these three
// switches (same ones docs/spike/menu-alt-probe.cjs uses). Harmless on a real interactive
// desktop too, so they stay on unconditionally rather than branching on environment.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultFile = path.join(__dirname, 'theme-probe-result.json');

const result = {
  probedAt: new Date().toISOString(),
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  sendSyncBootstrap: { ok: false, roundTripMs: null, error: null },
  shikiHighContrast: { ok: false, error: null }
};

// --- (b) Shiki: plain Node work, runs in the main process before any window exists. ---
async function probeShiki() {
  try {
    const { createHighlighter, createJavaScriptRegexEngine } = await import('shiki');
    const highlighter = await createHighlighter({
      themes: ['github-dark-high-contrast'],
      langs: [],
      engine: createJavaScriptRegexEngine()
    });
    const loaded = highlighter.getLoadedThemes();
    result.shikiHighContrast.ok = loaded.includes('github-dark-high-contrast');
    result.shikiHighContrast.loadedThemes = loaded;
    highlighter.dispose();
  } catch (err) {
    result.shikiHighContrast.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  }
}

// --- (a) sendSync under sandbox: true + contextIsolation: true. ---
// Two bridge functions: `themeBootstrap` is the call under test; `reportResult` is only this
// probe's own plumbing (the real app has no equivalent -- main.tsx just reads the return value
// directly) to get the timed result back to the main process without touching Node APIs from
// the page's own (sandboxed) script.
const PRELOAD_SRC = `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('themeProbe', {
  themeBootstrap: () => ipcRenderer.sendSync('theme:bootstrap'),
  reportResult: (payload) => ipcRenderer.send('probe:result', payload)
});
`;

// Inline <script> in <head>, before <body>: parses and runs synchronously, blocking the HTML
// parser (and so any paint) until it returns -- this is what main.tsx's real first-lines call
// will rely on.
const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script>
  const t0 = performance.now();
  let value, err = null;
  try {
    value = window.themeProbe.themeBootstrap();
  } catch (e) {
    err = String((e && e.stack) || e);
  }
  const t1 = performance.now();
  window.themeProbe.reportResult({ value, err, ms: t1 - t0 });
</script>
</head>
<body></body>
</html>`;

function probeSendSync() {
  return new Promise((resolve) => {
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'theme-probe-'));
    const preloadPath = path.join(scratchDir, 'preload.cjs');
    const htmlPath = path.join(scratchDir, 'index.html');
    writeFileSync(preloadPath, PRELOAD_SRC);
    writeFileSync(htmlPath, HTML);

    ipcMain.on('theme:bootstrap', (event) => {
      // Mirrors the real handler's shape (contracts/ipc.md "Bootstrap"): a plain synchronous
      // value, not Result<T>-shaped.
      event.returnValue = { theme: 'dark-high-contrast' };
    });

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    let settled = false;
    let timeoutId;
    function finish(outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
      resolve(outcome);
    }

    ipcMain.once('probe:result', (_event, parsed) => {
      if (parsed.err) {
        finish({ ok: false, roundTripMs: null, error: parsed.err });
      } else if (!parsed.value || parsed.value.theme !== 'dark-high-contrast') {
        finish({ ok: false, roundTripMs: parsed.ms, error: `unexpected return value: ${JSON.stringify(parsed.value)}` });
      } else {
        finish({ ok: true, roundTripMs: parsed.ms, error: null });
      }
      win.destroy();
    });

    // Fallback only: this must NOT be cleared by `did-finish-load` (that event fires right after
    // the page loads, long before a hung/never-arriving `probe:result` message would time out --
    // clearing it there defeated the whole timeout on an earlier run of this probe).
    timeoutId = setTimeout(() => {
      finish({ ok: false, roundTripMs: null, error: 'timed out after 5000ms -- sendSync likely hung' });
      win.destroy();
    }, 5000);

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      finish({ ok: false, roundTripMs: null, error: `did-fail-load: ${code} ${desc}` });
    });
    win.webContents.on('preload-error', (_e, preloadPathArg, error) => {
      finish({ ok: false, roundTripMs: null, error: `preload-error at ${preloadPathArg}: ${error instanceof Error ? error.message : String(error)}` });
    });
    win.loadFile(htmlPath);
  });
}

app.whenReady().then(async () => {
  await probeShiki();
  const sendSyncOutcome = await probeSendSync();
  result.sendSyncBootstrap = sendSyncOutcome;
  writeFileSync(resultFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nWrote ${resultFile}`);
  app.quit();
});
