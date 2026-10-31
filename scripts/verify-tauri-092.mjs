#!/usr/bin/env node
// Live CDP check for spec 092 (issues #1285 composer focus hand-off, #1295 masked extension secret input) against a built
// Tauri debug exe with the recorded-frame fake `omp`, a scratch REFRACT_DATA_DIR and its own debugging port.
// Fixtures: fixtures/omp-frames/stop-banner-1285.jsonl and secret-1295.jsonl (the `secret: true` frame is replayed, so no OMP 18.13.2 install is needed).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_092_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-092.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_092_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-092-shots-'));
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
const SHOTS = [];
let passed = 0;
const log = (line) => {
  console.log(line);
  REPORT.push(line);
};
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  passed += 1;
  log(`PASS: ${message}`);
}
const shot = async (cdp, name) => {
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  SHOTS.push(name);
};

const ACTIVE = `(() => { const a = document.activeElement; return a ? { tag: a.tagName, label: a.getAttribute('aria-label'), isBody: a === document.body, inBanner: !!a.closest('[data-pane-banner]') } : null; })()`;
const SECRET = 'hunter2-s3cret-1295';
const MESSAGE = `document.querySelector('textarea[aria-label="Message"]')`;
const SECRET_FIELD = `document.querySelector('input[data-secret-input]')`;
const TOGGLE = `document.querySelector('button[aria-label="Show secret"]')`;
const CANCEL_IN_FOOTER = `!!Array.from(document.querySelectorAll('[data-slot="card-footer"] button')).find((b) => b.textContent?.trim() === 'Cancel')`;

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** FR-007: the secret must not reach the app log or anything the app wrote to its data dir (UTF-8 and UTF-16LE). */
function assertSecretNotPersisted(dataDir, logFile) {
  const needles = [Buffer.from(SECRET, 'utf8'), Buffer.from(SECRET, 'utf16le')];
  assert(existsSync(logFile) && statSync(logFile).size > 0, 'The app log exists and is non-empty, so the leak scan has something to read');
  const targets = [...filesUnder(dataDir), logFile];
  const unreadable = [];
  const leaked = targets.filter((file) => {
    try {
      const bytes = readFileSync(file);
      return needles.some((needle) => bytes.includes(needle));
    } catch {
      unreadable.push(file);
      return false;
    }
  });
  if (unreadable.length) log(`Leak scan skipped ${unreadable.length} locked file(s)`);
  assert(leaked.length === 0, `The secret is absent, as plain UTF-8 or UTF-16LE, from the app log and ${targets.length - 1} scratch data files${leaked.length ? ` (found in ${leaked.join(', ')})` : ''}`);
}

async function withSession(scenario, tmp, exePath, launcherExe, shimDir, body, afterStop) {
  const dataDir = tmp(`data-${scenario}`);
  const importDir = tmp(`import-${scenario}`);
  const repoDir = makeScratchRepo(tmp(`repo-${scenario}`), `verify-092-${scenario}`);
  const logFile = path.join(SHOTS_DIR, `app-${scenario}.log`);
  const port = await getFreePort();
  let child, cdp;
  try {
    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir: importDir,
      pathPrepend: shimDir,
      logFile,
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: scenario
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`${scenario}: app pid ${launched.targetPid}, port ${port}`);
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 60_000, label: 'Readiness screen' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    try {
      await body(cdp);
    } catch (err) {
      await shot(cdp, `fail-${scenario}.png`).catch(() => {});
      log(`${scenario} page text: ${await cdp.evaluate('document.body.innerText.slice(0, 800)').catch(() => '?')}`);
      throw err;
    }
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child).catch(() => {});
  }
  afterStop?.(dataDir, logFile);
}

async function checkStopBannerFocus(cdp) {
  await cdp.typeIntoByLabel('Message', 'Turn for issue 1285: the agent exits mid-turn.');
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(`document.body.innerText.includes('t1285-')`, { timeoutMs: 30_000, label: 'Turn streaming' });
  await cdp.evaluate(`${MESSAGE}.focus()`);
  const before = await cdp.evaluate(ACTIVE);
  assert(before?.label === 'Message', `The composer textarea holds focus before the agent exits (${JSON.stringify(before)})`);
  await cdp.waitFor(`!!document.querySelector('[data-pane-banner]')`, { timeoutMs: 30_000, label: 'Stop banner' });
  await cdp.waitFor(`${MESSAGE}?.disabled === true`, { timeoutMs: 10_000, label: 'Composer disabled' });
  await cdp.waitFor(`!!document.activeElement?.closest('[data-pane-banner]')`, { timeoutMs: 10_000, label: 'Focus inside the stop banner' });
  const stranded = await cdp.evaluate(ACTIVE);
  log(`focus after stop: ${JSON.stringify(stranded)}`);
  assert(!stranded?.isBody, 'Focus is not stranded on <body> once the composer disables');
  assert(stranded?.inBanner === true, 'Focus moved into the stop banner');
  const buttonFocused = stranded?.tag === 'BUTTON';
  log(`banner focus target: ${buttonFocused ? 'first enabled button' : 'the banner itself'}`);
  await shot(cdp, '01-banner-focused.png');
  await cdp.click('document.activeElement');
  await cdp.waitFor(`!document.querySelector('[data-pane-banner]') && ${MESSAGE} && !${MESSAGE}.disabled`, { timeoutMs: 60_000, label: 'Composer re-enabled' });
  await cdp.waitFor(`document.activeElement === ${MESSAGE}`, { timeoutMs: 10_000, label: 'Focus back on the composer textarea' });
  const back = await cdp.evaluate(ACTIVE);
  log(`focus after re-enable: ${JSON.stringify(back)}`);
  assert(back?.label === 'Message', 'Focus returned to the composer textarea after the banner action');
  await shot(cdp, '02-composer-refocused.png');
}

async function checkSecretInput(cdp) {
  await cdp.typeIntoByLabel('Message', 'Turn for issue 1295: the agent asks for a secret.');
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(`!!${SECRET_FIELD}`, { timeoutMs: 30_000, label: 'Secret field' });
  const field = await cdp.evaluate(`(() => { const i = ${SECRET_FIELD}; return { type: i.type, autocomplete: i.autocomplete, spellcheck: i.spellcheck }; })()`);
  assert(field.type === 'password', 'The secret field is masked by default');
  assert(field.autocomplete === 'off' && field.spellcheck === false, 'Autocomplete and spellcheck are off');
  const pressed = () => cdp.evaluate(`${TOGGLE}.getAttribute('aria-pressed')`);
  assert((await pressed()) === 'false', 'The reveal toggle starts unpressed');
  await cdp.click(TOGGLE);
  await cdp.waitFor(`${SECRET_FIELD}.type === 'text'`, { timeoutMs: 5_000, label: 'Revealed' });
  assert((await pressed()) === 'true', 'The reveal toggle reports pressed when revealed');
  await cdp.click(TOGGLE);
  await cdp.waitFor(`${SECRET_FIELD}.type === 'password'`, { timeoutMs: 5_000, label: 'Masked again' });
  await cdp.click(SECRET_FIELD);
  await cdp.send('Input.insertText', { text: SECRET });
  await shot(cdp, '03-secret-masked.png');
  const typedValue = await cdp.evaluate(`${SECRET_FIELD}.value`);
  assert(typedValue === SECRET, 'Text inserted into the masked field (CDP insertText, not key events) arrives unchanged');
  assert(await cdp.evaluate(CANCEL_IN_FOOTER), 'Cancel sits in the card footer, away from the reveal toggle');
  await cdp.click(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Send' && b.closest('[role="group"]'))`);
  await cdp.waitFor(`document.body.innerText.includes('t1295-done')`, { timeoutMs: 20_000, label: 'Agent received the secret and finished' });
  const page = await cdp.evaluate(`({ text: document.body.innerText, html: document.documentElement.outerHTML, values: Array.from(document.querySelectorAll('input,textarea')).map((i) => i.value) })`);
  assert(!page.text.includes(SECRET) && !page.html.includes(SECRET) && !page.values.some((v) => v.includes(SECRET)), 'The answered state never shows the secret value, in text or any DOM attribute');
  await shot(cdp, '04-secret-entered.png');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-092: head ${head}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-092-${name}-`));
    dirs.push(dir);
    return dir;
  };
  let ok = false;
  try {
    const shimDir = tmp('shim');
    const launcherDir = tmp('launcher');
    const exeDir = tmp('exe');
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-092' });
    await withSession('stop-banner-1285', tmp, built.dest, launcherExe, shimDir, checkStopBannerFocus);
    await withSession('secret-1295', tmp, built.dest, launcherExe, shimDir, checkSecretInput, assertSecretNotPersisted);
    log(`verify-tauri-092: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(
      path.join(SHOTS_DIR, 'report.json'),
      JSON.stringify({ gitHead: head, ok, checks: passed, screenshots: SHOTS, secretPath: 'fake-omp tape secret-1295.jsonl (secret:true frame replayed)', log: REPORT }, null, 2)
    );
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-092: FAIL');
  console.error(err);
  process.exitCode = 1;
});
