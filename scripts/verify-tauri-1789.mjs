#!/usr/bin/env node
// Live CDP check for issue #1789: the composer `#` picker. Fake omp (tape slash-1812-cached, which answers prompts)
// and a fake `gh` on PATH (verify-tauri-1789-fake-gh.rs) keep it off GitHub; its argv log is the proof of what was searched.
// Launch 1: Project with a github.com origin. Launch 2: Project with no remote.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORK_DIR = process.env.REFRACT_1789_DIR || path.join(tmpdir(), 'r1789');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const CATALOG_FIXTURE = path.join(__dirname, 'fixtures', 'model-catalogs', 'chat-1069.json');
const COMPOSER = `document.querySelector('[aria-label="Message"]')`;
const OPTIONS = `Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).map((o) => o.textContent.trim().replace(/\\s+/g, ' '))`;

const findings = [];
const failures = [];
function check(label, ok, detail) {
  const text = `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`;
  (ok ? findings : failures).push(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
}

const key = async (cdp, code, name) => {
  const text = name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {};
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: name, code: name, modifiers: 0, ...text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: name, code: name, modifiers: 0 });
};
const type = async (cdp, text) => {
  await cdp.evaluate(`${COMPOSER}.focus()`);
  await cdp.send('Input.insertText', { text });
};
const draft = (cdp) => cdp.evaluate(`${COMPOSER}.value`);
const options = (cdp) => cdp.evaluate(OPTIONS);
const hasListbox = (cdp) => cdp.evaluate(`!!document.querySelector('[role="listbox"]')`);
async function clear(cdp) {
  await cdp.evaluate(`${COMPOSER}.focus()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA', modifiers: 2 });
  await key(cdp, 8, 'Backspace');
  await sleep(300);
}
const ghCalls = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('search/issues')) : []);

async function main() {
  mkdirSync(WORK_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(WORK_DIR, `run-${stamp}`);
  const shotsDir = path.join(WORK_DIR, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const dir = (n) => { const d = path.join(base, n); mkdirSync(d, { recursive: true }); return d; };
  const head = gitHead(REPO_ROOT);
  console.log(`verify-1789: git HEAD ${head}; shots ${shotsDir}`);

  const ghDir = dir('gh');
  const ghLog = path.join(ghDir, 'gh-calls.log');
  const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-1789-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
  if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
  process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_GH_LOG = ghLog;
  const managedGh = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
  if (existsSync(managedGh)) throw new Error(`${managedGh} exists; resolve_gh() would prefer it over the fake gh (#1343)`);

  const shim = dir('shim');
  buildOmpShim(shim);
  const launcherExe = buildLauncher(dir('launcher'));
  const built = buildAndCopyExeFresh(dir('exe'), BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1789' });
  const configStorePath = path.join(dir('cfg'), 'fake-omp-config-store.json');
  writeFileSync(configStorePath, JSON.stringify({
    modelRoles: { default: 'github-copilot/claude-fable-5', smol: 'anthropic/claude-haiku-5.5', slow: 'anthropic/claude-opus-5.5', planner: 'anthropic/claude-haiku-5.5' },
    cycleOrder: ['smol', 'default', 'slow']
  }));
  const conversationFile = path.join(dir('conv'), 'conversation.jsonl');
  writeFileSync(conversationFile, JSON.stringify({ type: 'model_change', model: 'github-copilot/claude-fable-5', role: 'default', resolvedModelIsFallback: false }) + '\n');

  const shots = [];
  let child, cdp;
  const shot = async (name) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(250);
    const file = path.join(shotsDir, name);
    await cdp.screenshot(file);
    shots.push(file);
  };
  const startSession = async (label, remote) => {
    const repoParent = dir(`repo-${label}`);
    const repoDir = makeScratchRepo(path.join(repoParent, `hello-world-${label}`), `verify-1789-${label}`);
    if (remote) spawnSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/octocat/hello-world.git'], { windowsHide: true });
    const debugLog = path.join(shotsDir, `fake-omp-${label}.log`);
    writeFileSync(debugLog, '');
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port, dataDir: dir(`data-${label}`), importSourceDir: dir(`import-${label}`), pathPrepend: `${shim}${path.delimiter}${ghDir}`, logFile: path.join(shotsDir, `app-${label}.log`),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'slash-1812-cached',
        REFRACT_FAKE_OMP_CONFIG_STORE: configStorePath,
        REFRACT_FAKE_OMP_MODEL_CATALOG: CATALOG_FIXTURE,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLog,
        REFRACT_FAKE_OMP_HOST_TOOL_RECORD: path.join(dir(`data-${label}`), 'host-tools.jsonl'),
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile,
        FAKE_GH_LOG: ghLog
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'readiness green' });
    await addRepository(cdp, repoDir);
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'new session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`(() => { const el = ${COMPOSER}; return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    await sleep(1500);
  };
  const stop = async () => {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    cdp = undefined;
    child = undefined;
  };

  try {
    await startSession('gh', true);

    // AC1 / intended 2: `#` alone lists open items, newest updated first, PRs and issues mixed.
    await type(cdp, '#');
    await cdp.waitFor(`${OPTIONS}.length > 0`, { timeoutMs: 15_000, label: 'picker rows' }).catch(() => {});
    const initial = await options(cdp);
    check('`#` opens the picker with open items, PRs and issues mixed, newest first', initial.length === 3 && /#42/.test(initial[0]) && /#12/.test(initial[1]) && /#31/.test(initial[2]), initial);
    check('rows show state word, #number and title', initial.every((r) => /(Open|Draft)/.test(r) && /#\d+/.test(r)) && /Pull request/.test(initial[0]) && /Issue/.test(initial[1]) && /Draft/.test(initial[2]), initial);
    const aria = await cdp.evaluate(`(() => { const c = ${COMPOSER}; return { role: c.getAttribute('role'), expanded: c.getAttribute('aria-expanded'), active: c.getAttribute('aria-activedescendant'), controls: c.getAttribute('aria-controls') }; })()`);
    check('composer is a combobox with aria-expanded and aria-activedescendant on a listbox option', aria.role === 'combobox' && aria.expanded === 'true' && !!aria.active && !!(await cdp.evaluate(`!!document.getElementById(${JSON.stringify(aria.active)})`)), aria);
    const live = await cdp.evaluate(`Array.from(document.querySelectorAll('[aria-live]')).map((e) => e.textContent.trim()).filter(Boolean)`);
    check('result count is announced in a live region', live.some((t) => /3/.test(t) && /result|match|item/i.test(t)), live);
    await shot('01-picker-open.png');

    // Intended 4: arrows move the selection.
    await key(cdp, 40, 'ArrowDown');
    const afterDown = await cdp.evaluate(`document.querySelector('[role="listbox"] [role="option"][aria-selected="true"]')?.textContent.trim().replace(/\\s+/g, ' ')`);
    check('ArrowDown moves the selection to the second row', /#12/.test(afterDown ?? ''), afterDown);

    // Intended 3: digits match by number, text by title, closed and merged included.
    await clear(cdp);
    await type(cdp, '#sav');
    await cdp.waitFor(`${OPTIONS}.length === 3`, { timeoutMs: 15_000, label: 'title rows' }).catch(() => {});
    const byTitle = await options(cdp);
    check('text after `#` filters by title and includes closed and merged items', byTitle.length === 3 && byTitle.some((r) => /#7\b/.test(r) && /Closed/.test(r)) && byTitle.some((r) => /#5\b/.test(r) && /Merged/.test(r)), byTitle);
    await shot('02-filtered-by-title.png');
    await clear(cdp);
    await type(cdp, '#12');
    await cdp.waitFor(`${OPTIONS}.some((r) => /#12\\b/.test(r))`, { timeoutMs: 15_000, label: 'number rows' }).catch(() => {});
    const byNumber = await options(cdp);
    check('digits find the item by number', /#12\b/.test(byNumber[0] ?? ''), byNumber);
    const calls = ghCalls(ghLog);
    check('only `gh api search/issues` scoped to the Project repository (repo: qualifier) is called', calls.length > 0 && calls.every((l) => /repo:octocat\/hello-world/.test(l)), calls.length);

    // Intended 4/5: Enter inserts `#<number> `; the first Enter only inserts, nothing is sent.
    await clear(cdp);
    await type(cdp, 'see #sav');
    await cdp.waitFor(`${OPTIONS}.length === 3`, { timeoutMs: 15_000, label: 'rows for insert' }).catch(() => {});
    await key(cdp, 13, 'Enter');
    await sleep(500);
    const inserted = await draft(cdp);
    check('Enter replaces the typed `#sav` with `#12 ` (first row is the first sorted match)', inserted === 'see #12 ' && !(await hasListbox(cdp)), inserted);
    await shot('03-inserted.png');

    // Esc closes and keeps the typed text; Tab inserts.
    await clear(cdp);
    await type(cdp, '#sav');
    await cdp.waitFor(`${OPTIONS}.length === 3`, { timeoutMs: 15_000, label: 'rows for esc' }).catch(() => {});
    await key(cdp, 27, 'Escape');
    await sleep(300);
    check('Esc closes the picker and keeps `#sav`', !(await hasListbox(cdp)) && (await draft(cdp)) === '#sav', await draft(cdp));
    await clear(cdp);
    await type(cdp, '#sav');
    await cdp.waitFor(`${OPTIONS}.length === 3`, { timeoutMs: 15_000, label: 'rows for tab' }).catch(() => {});
    await key(cdp, 9, 'Tab');
    await sleep(300);
    check('Tab inserts the highlighted row', (await draft(cdp)) === '#12 ', await draft(cdp));

    // Click inserts.
    await clear(cdp);
    await type(cdp, '#');
    await cdp.waitFor(`${OPTIONS}.length === 3`, { timeoutMs: 15_000, label: 'rows for click' }).catch(() => {});
    await cdp.click(`Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).find((o) => /#31/.test(o.textContent))`);
    await sleep(300);
    check('clicking a row inserts it', (await draft(cdp)) === '#31 ', await draft(cdp));

    // AC3: no picker inside a word, inline code or a code fence.
    await clear(cdp);
    await type(cdp, 'word#');
    await sleep(800);
    check('`#` inside a word opens no picker', !(await hasListbox(cdp)));
    await clear(cdp);
    await type(cdp, '`code #');
    await sleep(800);
    check('`#` inside inline code opens no picker', !(await hasListbox(cdp)));
    await clear(cdp);
    await type(cdp, '```\n#');
    await sleep(800);
    check('`#` inside a code fence opens no picker', !(await hasListbox(cdp)));
    await shot('04-no-picker-in-code.png');

    // Intended 7: loading row, then inline error with the text left as typed.
    await clear(cdp);
    writeFileSync(path.join(ghDir, 'delay-ms'), '4000');
    await type(cdp, '#cra');
    await cdp.waitFor(`document.body.textContent.includes('Searching')`, { timeoutMs: 3000, label: 'loading row' }).catch(() => {});
    check('a loading row shows while the search runs', await cdp.evaluate(`document.body.textContent.includes('Searching')`));
    await shot('05-loading.png');
    await clear(cdp);
    rmSync(path.join(ghDir, 'delay-ms'));
    writeFileSync(path.join(ghDir, 'fail'), '');
    await type(cdp, '#zzz');
    await cdp.waitFor(`document.body.textContent.includes('Could not') || document.body.textContent.includes('gh')`, { timeoutMs: 15_000, label: 'error row' }).catch(() => {});
    const errText = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="alert"],[data-tone="error"],div')).filter((e) => e.children.length === 0 && /could not|gh|offline|sign/i.test(e.textContent)).map((e) => e.textContent.trim()).slice(0, 3)`);
    check('a failed search shows an inline error and the typed text stays', errText.length > 0 && (await draft(cdp)) === '#zzz' && !(await options(cdp)).length, { errText, draft: await draft(cdp) });
    await shot('06-error.png');
    rmSync(path.join(ghDir, 'fail'));

    // AC2: the sent message renders the reference as a link with the #1155 hover card.
    await clear(cdp);
    await type(cdp, 'please look at #');
    await cdp.waitFor(`${OPTIONS}.length === 3`, { timeoutMs: 15_000, label: 'rows for send' }).catch(() => {});
    await key(cdp, 13, 'Enter');
    await sleep(300);
    await key(cdp, 13, 'Enter');
    const LINK = `Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '#42' && !b.closest('[role="listbox"]'))`;
    await cdp.waitFor(`!!(${LINK})`, { timeoutMs: 20_000, label: 'sent #42 link' }).catch(() => {});
    check('the sent message renders #42 as a link button', await cdp.evaluate(`!!(${LINK})`));
    const centre = await cdp.evaluate(`(() => { const r = (${LINK}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y });
    await cdp.waitFor(`document.body.textContent.includes('Add hash picker to the composer')`, { timeoutMs: 10_000, label: 'hover card' }).catch(() => {});
    check('hovering the link shows the Item card (#1155)', await cdp.evaluate(`!!document.querySelector('[data-slot="hover-card-content"]') && document.querySelector('[data-slot="hover-card-content"]').textContent.includes('Add hash picker to the composer')`));
    const sent = await cdp.evaluate(`(() => { const el = ${LINK}; el.scrollIntoView({ block: 'center' }); return true; })()`);
    void sent;
    await sleep(300);
    const c2 = await cdp.evaluate(`(() => { const r = (${LINK}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c2.x, y: c2.y + 1 });
    await sleep(1200);
    const file = path.join(shotsDir, '07-sent-link-hover-card.png');
    await cdp.screenshot(file);
    shots.push(file);
    await stop();

    // AC3 / intended 6: a Project with no GitHub repository types `#` normally.
    await startSession('nogh', false);
    const before = ghCalls(ghLog).length;
    await type(cdp, '#');
    await sleep(1500);
    check('no picker opens when the Project has no GitHub repository, `#` types normally', !(await hasListbox(cdp)) && (await draft(cdp)) === '#' && ghCalls(ghLog).length === before, { draft: await draft(cdp) });
    await shot('08-no-remote.png');
  } catch (err) {
    failures.push(`FAIL crash: ${err?.stack ?? err}`);
    console.error(err);
    try { if (cdp) await cdp.screenshot(path.join(shotsDir, 'crash.png')); } catch {}
  } finally {
    await stop();
  }
  console.log('screenshots:\n' + shots.map((s) => `  ${s}`).join('\n'));
  writeFileSync(path.join(shotsDir, 'report.json'), JSON.stringify({ head, findings, failures, shots }, null, 2));
  if (failures.length) {
    console.error(`verify-1789: ${failures.length} FAILURE(S)`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  } else console.log(`verify-1789: ALL ${findings.length} CHECKS PASSED`);
}

main().catch((err) => {
  console.error('verify-1789: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
