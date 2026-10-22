#!/usr/bin/env node
// Live CDP check for issue #766 part B: combined Role.Model pill, one switcher, Ctrl+R role
// cycling (600 ms debounce), pickers enabled mid-turn, and the "next turn" pending glyph.
// Drives the fake-omp tape `role-pill-766b.jsonl` plus a seeded `modelRoles` config store.
// Every check records a finding or a failure; the final verdict is derived from `failures`.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, getAccessibleName, getActiveElementAccessibleName } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORK_DIR = process.env.REFRACT_766B_DIR || 'C:\\Users\\shopwood\\r766b';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const CATALOG_FIXTURE = path.join(__dirname, 'fixtures', 'model-catalogs', 'chat-1069.json');
const CTRL = 2;
const SHIFT = 8;
const PILL = `document.querySelector('[data-role-model-pill]')`;
const PENDING_GLYPH = `document.querySelector('[data-role-model-pill] [data-pending-glyph]')`;

const SEEDED_MODEL_ROLES = {
  default: 'github-copilot/claude-fable-5',
  smol: 'anthropic/claude-haiku-5.5',
  slow: 'anthropic/claude-opus-5.5',
  plan: 'github-copilot/gpt-5.6-terra'
};

const findings = [];
const failures = [];
function check(label, ok, detail) {
  const text = `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`;
  if (ok) findings.push(`PASS ${text}`);
  else failures.push(`FAIL ${text}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const activeSummary = (cdp) => cdp.evaluate(`(() => { const a = document.activeElement; return a ? { tag: a.tagName, role: a.getAttribute('role'), pill: a.hasAttribute('data-role-model-pill'), label: a.getAttribute('aria-label'), id: a.id } : null })()`);
const pillState = (cdp) => cdp.evaluate(`(() => { const p = ${PILL}; return p ? { text: p.textContent.trim(), name: p.getAttribute('aria-label'), glyph: !!${PENDING_GLYPH} } : null })()`);
const key = async (cdp, code, name, mods = 0) => {
  const code2 = name.length === 1 ? `Key${name.toUpperCase()}` : name;
  const text = name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {};
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: name, code: code2, modifiers: mods, ...text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: name, code: code2, modifiers: mods });
};

async function main() {
  mkdirSync(WORK_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dirs = {};
  for (const n of ['shim', 'data', 'import', 'exe', 'launcher', 'repo', 'shots']) {
    dirs[n] = n === 'shots' ? path.join(WORK_DIR, n) : path.join(WORK_DIR, 'run-' + stamp, n);
    mkdirSync(dirs[n], { recursive: true });
  }
  const repoDir = makeScratchRepo(dirs.repo, 'verify-766b-role-model-pill');
  const configStorePath = path.join(dirs.data, 'fake-omp-config-store.json');
  writeFileSync(configStorePath, JSON.stringify({ modelRoles: SEEDED_MODEL_ROLES, cycleOrder: ['smol', 'default', 'slow'] }));
  const debugLogPath = path.join(dirs.shots, 'fake-omp-invocations.log');
  writeFileSync(debugLogPath, '');
  const conversationFile = path.join(dirs.data, 'conversation.jsonl');
  writeFileSync(conversationFile, JSON.stringify({ type: 'model_change', model: 'github-copilot/claude-fable-5', role: 'default', resolvedModelIsFallback: false }) + '\n');
  const head = gitHead(REPO_ROOT);
  console.log(`verify-766b: git HEAD ${head}`);

  const shots = [];
  let child, cdp;
  try {
    const port = await getFreePort();
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-766b' });
    console.log(`verify-766b: exe sha256 ${built.hash}`);
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: path.join(dirs.data, 'app'),
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.shots, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'role-pill-766b',
        REFRACT_FAKE_OMP_CONFIG_STORE: configStorePath,
        REFRACT_FAKE_OMP_MODEL_CATALOG: CATALOG_FIXTURE,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');

    const shot = async (name) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
      await sleep(250);
      const file = path.join(dirs.shots, name);
      await cdp.screenshot(file);
      shots.push({ name, sha256: sha256(file) });
    };

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'readiness mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'readiness green' });
    await addRepository(cdp, repoDir);
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'new session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });

    // Story-only DOM marker first: nothing below is meaningful without the new pill.
    await cdp.waitFor(`!!${PILL}`, { timeoutMs: 20_000, label: 'story marker [data-role-model-pill] present' });
    check('story marker [data-role-model-pill] present', true);
    check('old inert RoleChip + separate Model trigger are gone', await cdp.evaluate(`!Array.from(document.querySelectorAll('button')).some((b) => (b.getAttribute('aria-label') || '').endsWith(', role'))`));
    const sessionId = (await cdp.evaluate(`window.refract.sessions.list()`)).value[0].id;

    // 1. Pill at rest.
    await cdp.waitFor(`(${PILL}.textContent || '').includes('Default')`, { timeoutMs: 20_000, label: 'pill shows the role' }).catch(async () => console.log('session snapshot:', JSON.stringify((await cdp.evaluate('window.refract.sessions.list()')).value[0])));
    const rest = await pillState(cdp);
    check('pill text is "<Role> · <Model>"', /^\S+\s*·\s*.*Fable 5/.test(rest.text), rest.text);
    const axName = await getAccessibleName(cdp, PILL);
    check('pill accessible name (AX tree) is "<Role> role, Claude Fable 5 model"', /^(Default|Pinned)(?: role)?, Claude Fable 5 model$/.test(axName ?? ''), axName);
    check('exactly one tab stop for role+model', await cdp.evaluate(`document.querySelectorAll('[data-role-model-pill]').length === 1`));
    await shot('01-pill-at-rest.png');

    // 2. Switcher: Enter opens, Left/Right move roles, Tab/Down go to the model filter, Esc returns focus.
    await cdp.evaluate(`${PILL}.focus()`);
    await key(cdp, 13, 'Enter');
    const switcherOpen = `document.querySelectorAll('[aria-orientation="horizontal"] [role="option"]').length > 1`;
    const opened = await cdp.waitFor(switcherOpen, { timeoutMs: 5_000, label: 'switcher open' }).then(() => true, () => false);
    check('Enter on the pill opens the switcher', opened, await activeSummary(cdp));
    if (!opened) console.log('listbox html:', await cdp.evaluate(`(document.querySelector('[role="listbox"]') || document.body).outerHTML.slice(0, 1500)`));
    if (!opened) {
      await cdp.click(PILL);
      await cdp.waitFor(switcherOpen, { timeoutMs: 10_000, label: 'switcher open (click fallback)' });
    }
    const roleOptionCount = await cdp.evaluate(`document.querySelectorAll('[aria-orientation="horizontal"] [role="option"]').length`);
    const roleRow = `document.querySelector('[role="listbox"][aria-orientation="horizontal"]')`;
    const activeRole = () => cdp.evaluate(`(() => { const r = ${roleRow}; const id = r && r.getAttribute('aria-activedescendant'); const el = id && document.getElementById(id); return el ? el.textContent.trim() : null })()`);
    await sleep(200);
    const chipBoxes = await cdp.evaluate(`(() => { const pop = document.querySelector('[aria-label="Choose role or model"]').getBoundingClientRect(); return Array.from(document.querySelectorAll('[aria-label="Roles"] [role="option"]')).map((o) => { const r = o.getBoundingClientRect(); return { name: o.textContent.trim().slice(0, 12), inside: r.left >= pop.left - 0.5 && r.right <= pop.right + 0.5 && r.top >= pop.top - 0.5 && r.bottom <= pop.bottom + 0.5 && r.width > 0 } }) })()`);
    check('all four role chips (incl. Plan) sit fully inside the popover', chipBoxes.length === 4 && chipBoxes.every((c) => c.inside) && chipBoxes.some((c) => /^Plan/.test(c.name)), chipBoxes);
    check('role chips row exists and has focus on open', await cdp.evaluate(`document.activeElement === ${roleRow}`), roleOptionCount);
    await shot('02-switcher-open.png');
    const r0 = await activeRole();
    await key(cdp, 39, 'ArrowRight');
    await sleep(100);
    const r1 = await activeRole();
    await key(cdp, 37, 'ArrowLeft');
    await sleep(100);
    const r2 = await activeRole();
    check('ArrowRight moves to another role; ArrowLeft returns', r0 !== null && r1 !== null && r1 !== r0 && r2 === r0, { r0, r1, r2 });
    await key(cdp, 9, 'Tab');
    await sleep(150);
    const filterFocus = await cdp.evaluate(`document.activeElement && document.activeElement.getAttribute('role') === 'combobox'`);
    check('Tab moves from the role row to the model filter', filterFocus, await activeSummary(cdp));
    const optIds = () => cdp.evaluate(`document.activeElement.getAttribute('aria-activedescendant')`);
    const m0 = await optIds();
    await key(cdp, 40, 'ArrowDown');
    await sleep(100);
    const m1 = await optIds();
    await key(cdp, 38, 'ArrowUp');
    await sleep(100);
    const m2 = await optIds();
    check('ArrowDown/ArrowUp move through the model list', m1 !== m0 && m2 === m0, { m0, m1, m2 });
    await key(cdp, 9, 'Tab');
    await sleep(150);
    check('Tab moves back to the role row', await cdp.evaluate(`document.activeElement === ${roleRow}`));
    await key(cdp, 27, 'Escape');
    await sleep(300);
    check('Esc closes the switcher', await cdp.evaluate(`!document.querySelector('[role="listbox"][aria-orientation="horizontal"]')`));
    const afterEsc = await activeSummary(cdp);
    check('focus returns to the pill after Esc (not <body>)', afterEsc?.pill === true, afterEsc);

    // 3. Ctrl+R x3 within 600 ms: ONE applyRole IPC call.
    await cdp.evaluate(`window.__applyRoleCalls = []; const m = window.refract.model; const orig = m.applyRole.bind(m); m.applyRole = (...a) => { window.__applyRoleCalls.push(a); return orig(...a) }; true`);
    await cdp.evaluate(`document.querySelector('[aria-label="Message"]').focus()`);
    for (let i = 0; i < 3; i++) {
      await key(cdp, 82, 'r', CTRL);
      await sleep(80);
    }
    const mid = await pillState(cdp);
    check('pill updates at once on Ctrl+R (before the debounce)', mid.text !== rest.text, { before: rest.text, after: mid.text });
    const callsEarly = await cdp.evaluate(`window.__applyRoleCalls.length`);
    check('no applyRole call yet inside the 600 ms window', callsEarly === 0, callsEarly);
    await sleep(1500);
    const calls = await cdp.evaluate(`window.__applyRoleCalls`);
    check('Ctrl+R x3 within 600 ms makes exactly ONE applyRole call', calls.length === 1, calls);
    const toast = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent)`);
    check('a "Role: ..." notice was shown', toast.some((t) => /^Role: /.test(t)), toast);
    const afterCycle = await pillState(cdp);
    check('pill still reflects the new role after the call', afterCycle.text === mid.text, afterCycle.text);
    await cdp.evaluate(`window.__applyRoleCalls = []; true`);
    await key(cdp, 82, 'r', CTRL | SHIFT);
    await sleep(1200);
    const back = await pillState(cdp);
    check('Shift+Ctrl+R cycles backward (pill changes, one more call)', back.text !== afterCycle.text && (await cdp.evaluate(`window.__applyRoleCalls.length`)) === 1, back.text);
    check('Ctrl+R does not reload the page', await cdp.evaluate(`!!${PILL}`));

    // 4. Pickers enabled while a turn streams; pending glyph.
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'hello' });
    await cdp.pressEnter();
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(sessionId)}).status === 'working')`, { timeoutMs: 20_000, label: 'session status working' });
    const status = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(sessionId)}).status)`);
    check('session is working', status === 'working', status);
    const enabled = await cdp.evaluate(`(() => { const p = ${PILL}; const t = Array.from(document.querySelectorAll('[data-composer-row] button')).find((b) => /reasoning|medium|low|high|minimal/i.test(b.getAttribute('aria-label') || '')); return { pill: !!p && !p.disabled && p.getAttribute('aria-disabled') !== 'true', think: !!t && !t.disabled && t.getAttribute('aria-disabled') !== 'true', pillReason: /idle/i.test(p?.getAttribute('aria-label') || '') } })()`);
    check('pill and thinking picker are enabled while the turn streams', enabled.pill && enabled.think && !enabled.pillReason, enabled);
    await cdp.evaluate(`document.querySelector('[aria-label="Message"]').focus()`);
    await key(cdp, 82, 'r', CTRL);
    await sleep(1200);
    await cdp.waitFor(`!!${PENDING_GLYPH}`, { timeoutMs: 10_000, label: 'pending clock glyph' }).catch(() => {});
    const pend = await pillState(cdp);
    check('pending clock glyph shown', pend.glyph === true, pend);
    check('accessible name appends ", applies next turn"', /, applies next turn$/.test(pend.name ?? ''), pend.name);
    const pendAx = await getAccessibleName(cdp, PILL);
    check('AX name (tree) appends ", applies next turn"', /, applies next turn$/.test(pendAx ?? ''), pendAx);
    const live = await cdp.evaluate(`Array.from(document.querySelectorAll('[aria-live="polite"]')).map((e) => e.textContent.trim()).filter(Boolean)`);
    check('polite live region announces the queued change', live.some((t) => /queued for next turn/.test(t)), live);
    await shot('03-pending-glyph.png');
    await cdp.evaluate(`${PILL}.focus()`);
    await key(cdp, 13, 'Enter');
    await cdp.waitFor(`document.querySelectorAll('[aria-orientation="horizontal"] [role="option"]').length > 1`, { timeoutMs: 10_000, label: 'switcher open (pending)' });
    const tags = await cdp.evaluate(`({ keep: Array.from(document.querySelectorAll('[role="option"]')).some((o) => /^Keep current/.test(o.textContent.trim())), current: document.body.textContent.includes('current'), next: document.body.textContent.includes('next') })`);
    check('switcher shows "Keep current (…)" and current/next tags while pending', tags.keep && tags.current && tags.next, tags);
    await key(cdp, 27, 'Escape');
    await sleep(300);
    check('Esc only closes (pending kept)', (await pillState(cdp)).glyph === true);
    const aria = await cdp.evaluate(`window.refract.sessions.list().then((r) => !!r.value.find((s) => s.id === ${JSON.stringify(sessionId)}).pendingSelection)`);
    check('Rust reports a pendingSelection', aria === true);

    // 5. Narrow composer (< 400 px): model text hidden, role icon + name remain.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const narrow = await cdp.evaluate(`(() => { const row = document.querySelector('[data-composer-row]'); const p = ${PILL}; const spans = p ? Array.from(p.querySelectorAll('span')) : []; return { rowW: row?.getBoundingClientRect().width, visibleText: spans.filter((s) => s.getBoundingClientRect().width > 0).map((s) => s.textContent.trim()) } })()`);
    check('narrow: model text hidden below 400px, role name kept', narrow.rowW < 400 && !narrow.visibleText.some((t) => /Fable|Haiku|Opus|Terra/.test(t)) && narrow.visibleText.length > 0, narrow);
    await shot('04-narrow-380.png');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
  }

  const log = existsSync(debugLogPath) ? readFileSync(debugLogPath, 'utf8') : '';
  const setModels = (log.match(/RECV \{[^\n]*"message":"\/switch @/g) ?? []).length;
  console.log(`verify-766b: fake omp received ${setModels} "/switch @role" command(s) in total`);
  console.log('screenshots:');
  for (const s of shots) console.log(`  ${path.join(dirs.shots, s.name)}  sha256 ${s.sha256}`);
  if (shots.length !== 4) failures.push(`expected 4 screenshots, got ${shots.length}`);
  writeFileSync(path.join(dirs.shots, 'report.json'), JSON.stringify({ head, findings, failures, shots }, null, 2));
  if (failures.length) {
    console.error(`verify-766b: ${failures.length} FAILURE(S)`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  } else console.log(`verify-766b: ALL ${findings.length} CHECKS PASSED`);
}

main().catch((err) => {
  console.error('verify-766b: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
