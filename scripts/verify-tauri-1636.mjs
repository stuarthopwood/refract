#!/usr/bin/env node
// Live CDP check for #1636 (Usage Averages): recent-dated fixtures, real debug exe, fake omp/gh,
// scratch REFRACT_DATA_DIR and own port. Hand-computed averages are compared with the IPC summary
// and rendered cards (7d/All, with/without Project filter), plus the Session usage line, a Project
// whose only call is last month ("-" with an accessible name) and the filtered-empty state.

// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1636.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildFakeClis } from './verify-1331-fixtures.mjs';
import { createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1636';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(tmpdir(), 'refract-1636-usage');
const DAY = 86_400_000;

const line = (value) => `${JSON.stringify(value)}\n`;
const call = (id, ts, cost) =>
  line({
    type: 'message',
    id,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: ts,
      model: 'claude-sonnet',
      provider: 'github-copilot',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } }
    }
  });

/** Session-panel fixture: two calls, each input 10 + cacheRead 30 (75% hit rate), one of two tool calls errors. */
const SESSION_CALLS = [0.1, 0.3];
const SESSION_INPUT = 10;
const SESSION_CACHE_READ = 30;

function sessionCall(id, ts, cost, toolId) {
  return line({
    type: 'message',
    id,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }, { type: 'toolCall', id: toolId, name: 'bash', arguments: {} }],
      timestamp: ts,
      model: 'claude-sonnet',
      provider: 'github-copilot',
      usage: { input: SESSION_INPUT, output: 5, cacheRead: SESSION_CACHE_READ, cacheWrite: 0, totalTokens: SESSION_INPUT + 5 + SESSION_CACHE_READ, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } }
    }
  });
}

/** The focused Session's directory (the fake omp's conversation file lives in it). */
function writeSessionFixture(root, calls) {
  const dir = path.join(root, 'x-s1636');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's1.jsonl');
  const t0 = new Date(calls[0][0]).toISOString();
  const result = (id, ts, toolId, isError) => line({ type: 'message', id, timestamp: new Date(ts).toISOString(), message: { role: 'toolResult', toolCallId: toolId, isError, content: [{ type: 'text', text: 'out' }] } });
  writeFileSync(
    file,
    line({ type: 'session', id: 's1636', timestamp: t0, cwd: 'C:\\Work\\verify1636sess' }) +
      calls.map(([ts, cost], i) => sessionCall(`sc${i}`, ts, cost, `tc${i}`) + result(`sr${i}`, ts + 1, `tc${i}`, i === calls.length - 1)).join('')
  );
  return file;
}

/** One file per entry; `at` is milliseconds before now, `cost` USD. Times are pinned to local noon. */
function fixture(now) {
  const noon = (daysAgo) => {
    const d = new Date(now - daysAgo * DAY);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
  };
  return [
    { project: 'verify1636alpha', id: 'a1', calls: [[now - 60_000, 0.1], [now - 120_000, 0.1], [noon(3), 0.3]] },
    { project: 'verify1636alpha', id: 'a2', calls: [[noon(20), 0.5]] },
    { project: 'verify1636beta', id: 'b1', calls: [[noon(1), 0.2]] },
    // 45 days back is always a previous month, so this Project has no month-to-date data.
    { project: 'verify1636old', id: 'o1', calls: [[noon(45), 0.4]] },
    { project: 'verify1636sess', id: 's1636', session: true, calls: SESSION_CALLS.map((cost, i) => [now - 30_000 - i * 10_000, cost]) }
  ];
}

function writeFixture(sessionsDir, files) {
  for (const f of files.filter((x) => !x.session)) {
    const cwd = `C:\\Work\\${f.project}`;
    const folder = path.join(sessionsDir, `--C--Work-${f.project}--`);
    mkdirSync(folder, { recursive: true });
    const t0 = new Date(Math.min(...f.calls.map((c) => c[0]))).toISOString();
    const header =
      line({ type: 'session', id: f.id, timestamp: t0, cwd }) +
      line({ type: 'model_change', id: `${f.id}m`, timestamp: t0, model: 'github-copilot/claude-sonnet' }) +
      line({ type: 'thinking_level_change', id: `${f.id}t`, timestamp: t0, thinkingLevel: 'high' });
    writeFileSync(path.join(folder, `--C--Work-${f.project}--_${f.id}.jsonl`), header + f.calls.map(([ts, cost], i) => call(`${f.id}c${i}`, ts, cost)).join(''));
  }
}

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Independent of the renderer: walk back from the month's last day, tracking the weekday by hand. */
function weekdaysLeft(today) {
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  let dow = last.getDay();
  let n = 0;
  for (let day = last.getDate(); day > today.getDate(); day -= 1) {
    if (dow >= 1 && dow <= 5) n += 1;
    dow = (dow + 6) % 7;
  }
  return n;
}

/** Hand-computed expectations for a range and optional project, straight from the fixture. */
function expected(files, now, range, project) {
  const sel = files.filter((f) => !project || f.project === project);
  const all = sel.flatMap((f) => f.calls.map(([ts, cost]) => ({ ts, cost, file: f.id })));
  const inRange = all.filter((c) => range === 'all' || c.ts >= now - 7 * DAY);
  const today = new Date(now);
  const month = all.filter((c) => new Date(c.ts).getMonth() === today.getMonth() && new Date(c.ts).getFullYear() === today.getFullYear());
  const sum = (xs) => xs.reduce((a, c) => a + c.cost, 0);
  const days = (xs) => new Set(xs.map((c) => dayKey(c.ts))).size;
  const mtdDays = days(month);
  return {
    calls: inRange.length,
    spend: sum(inRange),
    activeDays: days(inRange),
    credits: sum(inRange) * 100,
    sessions: new Set(inRange.map((c) => c.file)).size,
    mtd: sum(month),
    mtdDays,
    projected: mtdDays > 0 ? sum(month) + (sum(month) / mtdDays) * weekdaysLeft(today) : null
  };
}

const usd = (v) => `$${v.toFixed(2)}`;
const perCall = (v) => (v < 1 ? `$${v.toFixed(3)}` : usd(v));
const int = (v) => Math.round(v).toLocaleString('en-US');
const pct = (rate) => `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
const plural = (n, noun) => `${int(n)} ${noun}${n === 1 ? '' : 's'}`;

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const failures = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    if (!ok) failures.push(label);
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  };
  const near = (a, b) => Math.abs(a - b) < 1e-6;

  const dirs = ['data', 'sessions', 'import', 'exe', 'launcher', 'shim', 'repo'].map((n) => mkdtempSync(path.join(tmpdir(), `refract-1636-${n}-`)));
  const [dataDir, sessionsDir, importSourceDir, exeDir, launcherDir, shimDir, repoDir] = dirs;
  let child;
  let cdp;
  const ipc = async (method, ...args) => {
    const r = await cdp.evaluate(`window.refract.usage.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    if (!r || r.ok !== true) throw new Error(`usage.${method} failed: ${JSON.stringify(r)}`);
    return r.value;
  };
  try {
    const now = Date.now();
    const files = fixture(now);
    writeFixture(sessionsDir, files);
    const sessionFile = writeSessionFixture(sessionsDir, files.find((f) => f.session).calls);
    buildFakeClis(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_OMP_SESSIONS_DIR: sessionsDir,
        OMP_PROFILE: 'verify1636',
        REFRACT_FAKE_OMP_SCENARIO: 'activity-line-526',
        REFRACT_FAKE_OMP_CONVERSATION_FILE: sessionFile
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the process this run launched`);
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'usage api' });
    await ipc('start');
    const total = files.reduce((a, f) => a + f.calls.length, 0);
    for (let i = 0; i < 100; i++) {
      if ((await ipc('summary', { range: 'all' })).calls >= total) break;
      await sleep(300);
    }
    const labels = (await ipc('breakdown', { range: 'all' }, 'project')).map((r) => r.label);
    const labelOf = (project) => labels.find((l) => l.includes(project.replace('verify1636', '')));
    const alpha = labelOf('verify1636alpha');
    check(!!alpha, 'project labels include the alpha fixture project', labels);

    // IPC summary against hand-computed values.
    const scenarios = [
      ['7d', null],
      ['all', null],
      ['7d', 'verify1636alpha'],
      ['all', 'verify1636alpha'],
      // Only call is 45 days back: every figure is real except Projected month spend, which is "-".
      ['all', 'verify1636old']
    ];
    check(!!labelOf('verify1636old'), 'project labels include the old fixture project', labels);
    for (const [range, project] of scenarios) {
      const e = expected(files, now, range, project);
      const s = await ipc('summary', { range, project: project ? labelOf(project) : null }, -new Date().getTimezoneOffset());
      const ok = s.calls === e.calls && near(s.spendUsd, e.spend) && s.activeDays === e.activeDays && s.sessions === e.sessions && near(s.monthToDateUsd, e.mtd) && s.monthActiveDays === e.mtdDays;
      check(ok, `summary ${range}${project ? ' + Project' : ''} matches hand computation`, { s, e });
    }
    const mtd7 = (await ipc('summary', { range: '7d' }, -new Date().getTimezoneOffset())).monthToDateUsd;
    const mtdAll = (await ipc('summary', { range: 'all' }, -new Date().getTimezoneOffset())).monthToDateUsd;
    check(near(mtd7, mtdAll), 'month-to-date ignores the date range', { mtd7, mtdAll });

    // Add a scratch repo so the left nav exists, then open Usage.
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repoDir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('commit', '--allow-empty', '-q', '-m', 'init');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'readiness green' });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.clickByText('Local folder…', { tag: '[role="menuitem"]' });
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'repository added' });

    // Session usage panel (stacked layout): the focused Session's line under the four cards.
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    const rail = `document.querySelector('[data-rail-button="session-usage"]')`;
    if (!(await cdp.evaluate(`!!${rail}`))) await cdp.click(`document.querySelector('[data-rail-toggle]') ?? document.querySelector('[aria-label="Right pane"]')`);
    await cdp.waitFor(`!!${rail}`, { timeoutMs: 15_000, label: 'Session usage rail button' });
    await cdp.click(rail);
    await sleep(1200);
    // A persisted active panel makes the rail click close it, leaving the picker.
    if (await cdp.evaluate(`document.body.innerText.includes('Agent Builder')`)) await cdp.clickByText('Session usage');
    await cdp.waitFor(`document.body.innerText.includes('By model')`, { timeoutMs: 40_000, label: 'Session usage panel populated' });
    await sleep(1500);
    const sessionLine = await cdp.evaluate(`(() => { const p = [...document.querySelectorAll('p')].find((el) => el.innerText.startsWith('Cache hit rate')); return p ? p.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
    const sCost = SESSION_CALLS.reduce((a, c) => a + c, 0);
    const wantLine = `Cache hit rate ${pct(SESSION_CACHE_READ / (SESSION_INPUT + SESSION_CACHE_READ))} · Tool error rate ${pct(1 / SESSION_CALLS.length)} · Avg spend per call ${perCall(sCost / SESSION_CALLS.length)}`;
    check(sessionLine === wantLine, 'Session usage panel line matches hand computation', { sessionLine, wantLine });
    await cdp.screenshot(path.join(SHOTS_DIR, '0-session-panel.png'));

    // Each group's innerText split into its label / value / caption paragraphs, plus any "No data" images.
    const cards = () =>
      cdp.evaluate(
        `[...document.querySelectorAll('section[aria-label="Usage"] [role="group"]')].map((g) => ({ segs: g.innerText.split('\\n').map((s) => s.trim()).filter(Boolean), imgs: [...g.querySelectorAll('[role="img"]')].map((i) => i.getAttribute('aria-label')) }))`
      );
    const card = (all, label) => all.find((c) => c.segs[0] === label) ?? { segs: [], imgs: [] };
    const groupsReady = `[...document.querySelectorAll('section[aria-label="Usage"] [role="group"]')].some((g) => g.innerText.startsWith('Projected month spend'))`;
    const shots = ['1-averages-7d', '2-averages-all', '3-averages-7d-project', '4-averages-all-project', '5-averages-all-old-project'];
    let rendered = 0;
    for (const [i, [range, project]] of scenarios.entries()) {
      await ipc('setPrefs', { filters: { range, project: project ? labelOf(project) : null } });
      await cdp.evaluate(`location.reload()`).catch(() => {});
      await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'reloaded' });
      await cdp.clickByText('Usage');
      await cdp.waitFor(groupsReady, { label: 'Averages render' });
      await sleep(600);
      const e = expected(files, now, range, project);
      const all = await cards();
      const name = `${range}${project ? ' + Project' : ''}`;
      const days = e.activeDays ? `Over ${plural(e.activeDays, 'active day')}` : undefined;
      const none = project === 'verify1636old';
      // `value` null means the card must show the dash with the accessible name "No data".
      const want = (label, value, caption) => {
        const c = card(all, label);
        const shown = value === null ? '-' : value;
        const ok = c.segs[1] === shown && (value === null ? c.imgs.includes('No data') : c.imgs.length === 0) && (caption === undefined || c.segs[2] === caption);
        check(ok, `${name}: ${label} shows ${shown}${caption ? ` / ${caption}` : ''}`, c);
      };
      want('Avg spend per day', usd(e.spend / e.activeDays), days);
      want('Avg credits per day', int(e.credits / e.activeDays), `${days} · credits are Copilot only`);
      want('Avg calls per day', int(e.calls / e.activeDays), days);
      want('Avg spend per call', perCall(e.spend / e.calls), `Over ${plural(e.calls, 'call')}`);
      want('Avg spend per Session', usd(e.spend / e.sessions), `Over ${plural(e.sessions, 'Session')}`);
      want('Projected month spend', e.projected === null ? null : usd(e.projected), 'This month, ignores the date range');
      if (none) check(e.projected === null, `${name}: fixture really has no month-to-date data`, e);
      await cdp.evaluate(`[...document.querySelectorAll('section[aria-label="Usage"] [role="group"]')].find((g) => g.innerText.startsWith('Projected month spend')).scrollIntoView({ block: 'center' })`);
      await cdp.screenshot(path.join(SHOTS_DIR, `${shots[i]}.png`));
      rendered += 1;
    }
    check(rendered === scenarios.length, `all ${scenarios.length} scenarios rendered`, { rendered });

    // A Project matching nothing: calls are 0, so the view shows the filtered-empty state instead of
    // six dashes; the Averages section must not render at all.
    const nothing = 'verify1636nothing';
    const sNone = await ipc('summary', { range: 'all', project: nothing }, -new Date().getTimezoneOffset());
    check(sNone.calls === 0 && sNone.activeDays === 0 && sNone.sessions === 0 && sNone.monthActiveDays === 0, 'summary for a Project matching nothing is all zero', sNone);
    await ipc('setPrefs', { filters: { range: 'all', project: nothing } });
    await cdp.evaluate(`location.reload()`).catch(() => {});
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'reloaded' });
    await cdp.clickByText('Usage');
    await cdp.waitFor(`document.body.innerText.includes('No usage matches these filters.')`, { timeoutMs: 20_000, label: 'filtered-empty state' });
    const emptyGroups = await cards();
    check(!emptyGroups.some((c) => ['Projected month spend', 'Avg spend per day'].includes(c.segs[0] ?? '')), 'filtered-empty state renders no Averages cards', emptyGroups);
    await cdp.screenshot(path.join(SHOTS_DIR, '6-filtered-empty.png'));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, failures, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write evidence: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  console.log(`${LOG}: ${failures.length ? `FAILED (${failures.length})` : 'all checks passed'}; evidence in ${SHOTS_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
