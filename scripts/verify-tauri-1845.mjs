#!/usr/bin/env node
// Live CDP check for #1845: a version 3 usage.db whose dollar columns are still named `cost_share`
// is migrated in place (history kept), and the by-tool table shows each tool's Cost share as a
// percentage of the window's tool spend, or a labelled dash when nothing in the window was priced.
// Scratch REFRACT_DATA_DIR and sessions folder; never touches %APPDATA%.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1845.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { assistantLine, buildFakeClis, entry } from './verify-1331-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1845';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(tmpdir(), 'refract-1845-cost-share');
const HOUR = 3_600_000;
const SEED_HOUR = Date.parse('2026-09-01T10:00:00.000Z');
const CWD = 'C:\\Work\\verify1845proj';

// Version 3 layout: the tool dollar columns carry the old name `cost_share`.
const V3_DDL = `
CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0, last_modified INTEGER NOT NULL DEFAULT 0,
  file_len INTEGER NOT NULL DEFAULT 0, session_id TEXT NOT NULL DEFAULT '', cwd TEXT, agent_type TEXT NOT NULL DEFAULT 'main',
  project_label TEXT NOT NULL DEFAULT '', cur_model TEXT NOT NULL DEFAULT '', cur_reasoning TEXT NOT NULL DEFAULT '',
  head_len INTEGER NOT NULL DEFAULT 0, head_hash INTEGER NOT NULL DEFAULT 0, tail_len INTEGER NOT NULL DEFAULT 0, tail_hash INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, ts INTEGER NOT NULL, session_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '', agent_type TEXT NOT NULL DEFAULT 'main',
  purpose TEXT, project_label TEXT NOT NULL DEFAULT '', input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0, cost_input REAL NOT NULL DEFAULT 0, cost_output REAL NOT NULL DEFAULT 0,
  cost_cache_read REAL NOT NULL DEFAULT 0, cost_cache_write REAL NOT NULL DEFAULT 0, credits REAL, premium_requests REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER, ttft_ms INTEGER, stop_reason TEXT, PRIMARY KEY (session_file, entry_id)) WITHOUT ROWID;
CREATE TABLE tool_calls (session_file TEXT NOT NULL, tool_call_id TEXT NOT NULL, ts INTEGER NOT NULL, entry_id TEXT NOT NULL, tool TEXT NOT NULL,
  is_error INTEGER, result_chars INTEGER NOT NULL DEFAULT 0, cost_share REAL NOT NULL DEFAULT 0, project_label TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '', agent_type TEXT NOT NULL DEFAULT 'main',
  PRIMARY KEY (session_file, tool_call_id)) WITHOUT ROWID;
CREATE TABLE user_messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, ts INTEGER NOT NULL, chars INTEGER NOT NULL DEFAULT 0,
  yelling INTEGER NOT NULL DEFAULT 0, profanity INTEGER NOT NULL DEFAULT 0, blame INTEGER NOT NULL DEFAULT 0,
  project_label TEXT NOT NULL DEFAULT '', PRIMARY KEY (session_file, entry_id)) WITHOUT ROWID;
CREATE TABLE message_rollup (hour INTEGER NOT NULL, project_label TEXT NOT NULL, model TEXT NOT NULL, reasoning TEXT NOT NULL,
  agent_type TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0, cost_input REAL NOT NULL DEFAULT 0, cost_output REAL NOT NULL DEFAULT 0,
  cost_cache_read REAL NOT NULL DEFAULT 0, cost_cache_write REAL NOT NULL DEFAULT 0, credits REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, project_label, model, reasoning, agent_type)) WITHOUT ROWID;
CREATE TABLE tool_rollup (hour INTEGER NOT NULL, project_label TEXT NOT NULL, tool TEXT NOT NULL, agent_type TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, result_chars INTEGER NOT NULL DEFAULT 0,
  cost_share REAL NOT NULL DEFAULT 0, PRIMARY KEY (hour, project_label, tool, agent_type)) WITHOUT ROWID;
CREATE TABLE session_rollup (session_file TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT '', first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL, calls INTEGER NOT NULL DEFAULT 0, cost_total REAL NOT NULL DEFAULT 0, credits REAL NOT NULL DEFAULT 0,
  project_label TEXT NOT NULL DEFAULT '');
CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 3;
`;

// Priced project: bash 3.00 + read 1.00 dollars. Free project: one unpriced tool.
const SEED_ROLLUP = [
  ['priced', 'bash', 3, 3.0],
  ['priced', 'read', 2, 1.0],
  ['free', 'edit', 4, 0]
];

function seedOldDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(V3_DDL);
  const rollup = db.prepare(`INSERT INTO tool_rollup (hour, project_label, tool, agent_type, calls, cost_share) VALUES (?, ?, ?, 'main', ?, ?)`);
  const calls = db.prepare(
    `INSERT INTO tool_calls (session_file, tool_call_id, ts, entry_id, tool, is_error, cost_share, project_label) VALUES ('old.jsonl', ?, ?, 'e', ?, 0, ?, ?)`
  );
  let n = 0;
  for (const [project, tool, count, usd] of SEED_ROLLUP) {
    rollup.run(SEED_HOUR, project, tool, count, usd);
    for (let i = 0; i < count; i++) calls.run(`c${n++}`, SEED_HOUR + i, tool, usd / count, project);
  }
  // The view treats a window with no model call as empty, so the unpriced project needs one free call.
  db.exec(
    `INSERT INTO message_rollup (hour, project_label, model, reasoning, agent_type, calls, input, output, total_tokens)
    VALUES (${SEED_HOUR}, 'free', 'github-copilot/free-model', '', 'main', 1, 10, 5, 15)`
  );
  db.close();
}

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

  const dirs = ['data', 'sessions', 'import', 'exe', 'launcher', 'shim', 'repo', 'copilot'].map((n) => mkdtempSync(path.join(tmpdir(), `refract-1845-${n}-`)));
  const [dataDir, sessionsDir, importSourceDir, exeDir, launcherDir, shimDir, repoDir, copilotHome] = dirs;

  let child;
  let cdp;
  const call = async (method, ...args) => {
    const r = await cdp.evaluate(`window.refract.usage.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    if (!r || r.ok !== true) throw new Error(`usage.${method} failed: ${JSON.stringify(r)}`);
    return r.value;
  };
  const toolText = `(document.querySelector('section[aria-label="Usage"]')?.innerText ?? '')`;
  try {
    buildFakeClis(shimDir);
    seedOldDb(path.join(dataDir, 'usage.db'));
    const folder = path.join(sessionsDir, '--C--Work-verify1845proj--');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, '--C--Work-verify1845proj--_s1.jsonl'),
      entry({ type: 'session', id: 's1', timestamp: '2026-10-01T10:00:00.000Z', cwd: CWD }) +
        entry({ type: 'model_change', id: 'm1', timestamp: '2026-10-01T10:00:01.000Z', model: 'github-copilot/claude-sonnet' }) +
        assistantLine('a1', [10, 5, 100], 0.03)
    );

    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      // COPILOT_HOME keeps the scan off the real ~/.copilot/session-state.
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importSourceDir, REFRACT_OMP_SESSIONS_DIR: sessionsDir, COPILOT_HOME: copilotHome }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the launched pid ${launched.targetPid}`);
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'window.refract.usage present' });
    await call('start');
    for (let i = 0; i < 100; i++) {
      const s = await call('status');
      if (!s.running && s.sessionsDone >= s.sessionsSeen && s.sessionsSeen > 0) break;
      await sleep(300);
    }

    // IPC: shares come back as fractions of the window's tool spend; the unpriced window has none.
    const share = (rows, label) => rows.find((r) => r.label === label)?.costShare;
    const all = await call('breakdown', { range: 'all' }, 'tool');
    check(share(all, 'bash') === 0.75 && share(all, 'read') === 0.25 && share(all, 'edit') === 0, 'the migrated history gives bash 75%, read 25%, edit 0%', all);
    const free = await call('breakdown', { range: 'all', project: 'free' }, 'tool');
    check(free.length === 1 && free[0].costShare === undefined, 'a window with no priced tool call has no share', free);

    // The left nav only exists once a repository is added.
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repoDir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('commit', '--allow-empty', '-q', '-m', 'init');
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'readiness green' }
    );
    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'repository added' });

    const openUsageWith = async (filters) => {
      await call('setPrefs', { filters });
      await cdp.evaluate(`location.reload()`).catch(() => {});
      await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'reloaded' });
      const rendered = await cdp.evaluate(`${toolText}.includes('Tool error rate')`).catch(() => false);
      if (!rendered) await cdp.clickByText('Usage');
      await cdp.waitFor(`${toolText}.includes('Tool error rate')`, { label: 'Usage view renders' }).catch(async (err) => {
        await cdp.screenshot(path.join(SHOTS_DIR, 'failure-usage-view.png')).catch(() => {});
        throw err;
      });
      await sleep(800);
    };

    const scrollToolsIntoView = async () => {
      await cdp.evaluate(
        `(() => { const cell = [...document.querySelectorAll('section[aria-label="Usage"] th')].find((e) => /cost share/i.test(e.textContent)); (cell?.closest('table') ?? cell)?.scrollIntoView({ block: 'center' }); return !!cell; })()`
      );
      await sleep(300);
    };

    await openUsageWith({ range: 'all' });
    let page = await cdp.evaluate(toolText);
    check(/75(\.\d+)?%/.test(page) && /25(\.\d+)?%/.test(page), 'the tools table shows percentages', page.length);
    await scrollToolsIntoView();
    await cdp.screenshot(path.join(SHOTS_DIR, '1-tools-cost-share-percentages.png'));

    await openUsageWith({ range: 'all', project: 'free' });
    // The Cost share cell of the unpriced `edit` row, not the page text: a dash with an accessible name.
    const emptyCell = await cdp.evaluate(
      `(() => { const table = [...document.querySelectorAll('section[aria-label="Usage"] table')].find((t) => /cost share/i.test(t.querySelector('thead')?.textContent ?? ''));
        const row = [...(table?.querySelectorAll('tbody tr') ?? [])].find((r) => r.cells[0]?.textContent.trim() === 'edit');
        const img = row?.cells[row.cells.length - 1]?.querySelector('[role="img"]');
        return row ? { text: row.cells[row.cells.length - 1].textContent.trim(), label: img?.getAttribute('aria-label') ?? null } : null; })()`
    );
    check(emptyCell?.text === '-' && emptyCell?.label === 'No priced calls', 'the unpriced edit row shows a dash named "No priced calls" in its Cost share cell', emptyCell);
    await scrollToolsIntoView();
    await cdp.screenshot(path.join(SHOTS_DIR, '2-tools-cost-share-no-priced-calls.png'));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: head, failures, results: report }, null, 2)
      );
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
