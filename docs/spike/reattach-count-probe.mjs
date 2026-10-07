// Reattach message-count probe (docs/spike/FINDINGS.md item 44; issue #449).
//
// Question: after a reload (switch_session on a copy of a real Conversation file), does
// `get_state.messageCount`/`get_messages` ever come back LOWER than the raw entry count the
// file itself holds? Constitution v1.7.0's Principle III treated any drop as a hard reattach
// failure ("messageCount N is below last known M"); this probe reproduces that exact failure
// against a real Conversation copy to settle whether the drop is a genuine corruption (the old
// rule's assumption) or an OMP-side artifact of reload dropping some message class (aborted
// assistant turns, at least) that Refract's own settle flow still counted when it saved
// `lastMessageCount`.
//
// Generic by design: takes a source .jsonl Conversation file and its recorded cwd (the
// worktree OMP originally ran in) as CLI arguments, so it can be rerun against any Conversation,
// not just the one FINDINGS item 44 was recorded against.
//
// Run:  node docs/spike/reattach-count-probe.mjs <source.jsonl> <cwd>
// Env:  PINION_OMP  omp executable (default "omp" from PATH)
//
// Read-only: no prompt is ever sent, and no file under the source's own directory is ever
// opened directly -- the source is copied into a scratch `--session-dir` first (FINDINGS item
// 5/61: OMP rewrites a session file on reopen), so the original is never mutated. Raw RPC frames
// are held in memory only, never written to disk; only the scratch copy of the transcript lives
// on disk, under the OS temp dir, whose path is printed at the end. Quality-gate
// remediation (gate cycle 2, #449, PROJECT RULE): this scratch dir is now left on disk on
// purpose and never deleted by this script -- AGENTS.md forbids `fs.rm`/`fs.rmSync` on a target
// built from a variable (ROOT here is an `fs.mkdtempSync` directory, private and randomly
// suffixed, not a predictable `Date().toISOString()` path). Delete it by hand once you're done
// with it; the printed path is always the literal one to pass.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OMP = process.env.PINION_OMP || 'omp';
const READY_MS = 120_000;
const REQUEST_MS = 60_000;

const [, , SRC, CWD] = process.argv;
if (!SRC || !CWD) {
  console.error('usage: node docs/spike/reattach-count-probe.mjs <source.jsonl> <cwd>');
  process.exit(2);
}
if (!fs.existsSync(SRC)) {
  console.error(`source Conversation file not found: ${SRC}`);
  process.exit(2);
}
if (!fs.existsSync(CWD)) {
  console.error(`cwd (recorded worktree) not found: ${CWD}`);
  process.exit(2);
}

let ROOT;
let rootCreated = false;
let SESSION_DIR;

let buf = Buffer.alloc(0);
const frames = [];
const chunks = new Map();
const waiters = [];
function dispatch(f) {
  frames.push(f);
  for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
}
const waitFor = (pred, ms, what) => new Promise((resolve, reject) => {
  const hit = frames.find(pred);
  if (hit) return resolve(hit);
  const t = setTimeout(() => reject(new Error('timeout ' + what)), ms);
  waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
});
let n = 0;
let child;
async function req(cmd) {
  const id = 'p' + ++n;
  child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
  return waitFor((f) => f.type === 'response' && f.id === id, REQUEST_MS, cmd.type);
}
let exitCode = 0;

try {
  // Quality-gate remediation (gate cycle 2, #449): the `omp --version` check used to run ahead
  // of this `try`, outside the probe's one error-handling path, so a missing `omp` binary
  // exited through an ad hoc branch instead of the probe's normal "exit non-zero with a
  // message" contract. It now runs first here, before the scratch dir exists at all, so a
  // failed version check never creates one. The scratch dir itself (round 3, security-auditor
  // Low: now a private `fs.mkdtempSync` directory, not a predictable timestamp path) is still
  // created immediately before the transcript copy that follows it, not before the version
  // check -- a failure in the copy itself can still leave an empty session dir behind; see
  // `rootCreated` in the `finally` block below for why that case is still reported honestly.
  const ompVersion = execFileSync(OMP, ['--version'], { encoding: 'utf8' }).trim();

  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pinion-reattach-count-probe-'));
  rootCreated = true;
  SESSION_DIR = path.join(ROOT, 'sessions');
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const copy = path.join(SESSION_DIR, path.basename(SRC));
  fs.copyFileSync(SRC, copy);

  // Raw entry count/shape straight from the source file, independent of OMP: every line is one
  // JSON entry; a `"message"` entry's `role` and (for assistant turns) `stopReason` live under
  // its nested `message` object, not at the top level.
  const rawLines = fs.readFileSync(SRC, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const rawEntries = rawLines.map((l) => JSON.parse(l));
  const rawByType = {};
  for (const e of rawEntries) rawByType[e.type ?? 'unknown'] = (rawByType[e.type ?? 'unknown'] || 0) + 1;
  const rawMessages = rawEntries.filter((e) => e.type === 'message');
  const rawByRole = {};
  for (const m of rawMessages) rawByRole[m.message?.role ?? 'unknown'] = (rawByRole[m.message?.role ?? 'unknown'] || 0) + 1;
  const abortedAssistant = rawMessages.filter((m) => m.message?.role === 'assistant' && m.message?.stopReason === 'aborted').length;

  console.log(`omp ${ompVersion}\nsource: ${SRC}\ncwd: ${CWD}\nscratch: ${ROOT}\n`);
  console.log(
    `raw file: ${rawEntries.length} entries (${JSON.stringify(rawByType)}); ${rawMessages.length} "message" entries by role ${JSON.stringify(rawByRole)}; ${abortedAssistant} aborted assistant message(s)\n`
  );

  child = spawn(OMP, ['--mode', 'rpc-ui', '--approval-mode=always-ask', '--session-dir', SESSION_DIR], {
    cwd: CWD,
    stdio: 'pipe',
    windowsHide: true,
  });
  // Quality-gate remediation (gate cycle 2, #449): without this, a spawn failure (e.g. `omp`
  // resolved by the version check above but gone by the time we actually launch it, or a
  // permissions error) left the probe hanging until the `ready` wait's own 120s timeout instead
  // of failing fast with a real message. Raced against the `ready` wait below rather than routed
  // through `waiters` (which only knows how to resolve, not reject, a pending wait).
  let spawnErrorReject;
  const spawnError = new Promise((_resolve, reject) => { spawnErrorReject = reject; });
  child.on('error', (e) => spawnErrorReject(new Error(`failed to start ${OMP}: ${e.message}`)));
  child.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, i).toString('utf8').trim();
      buf = buf.subarray(i + 1);
      if (!line) continue;
      let f;
      try { f = JSON.parse(line); } catch { continue; }
      if (f.type === 'rpc_chunk') {
        let c = chunks.get(f.chunkId);
        if (!c) { c = { parts: new Array(f.count), got: 0 }; chunks.set(f.chunkId, c); }
        if (!c.parts[f.index]) c.got++;
        c.parts[f.index] = Buffer.from(f.data, 'base64');
        if (c.got === f.count) { chunks.delete(f.chunkId); dispatch(JSON.parse(Buffer.concat(c.parts).toString('utf8'))); }
        continue;
      }
      dispatch(f);
    }
  });

  const ready = await Promise.race([waitFor((f) => f.type === 'ready', READY_MS, 'ready'), spawnError]);
  if (ready.supportedProtocolVersions?.includes(2)) await req({ type: 'negotiate_protocol', protocolVersion: 2 });
  const sw = await req({ type: 'switch_session', sessionPath: copy });
  if (!sw.success || sw.data?.cancelled || sw.error) {
    throw new Error(`switch_session failed: success=${sw.success} cancelled=${sw.data?.cancelled} error=${sw.error}`);
  }
  const st = (await req({ type: 'get_state' })).data;
  const msgs = (await req({ type: 'get_messages' })).data.messages;
  const byRole = {};
  for (const m of msgs) byRole[m.role] = (byRole[m.role] || 0) + 1;
  console.log(
    JSON.stringify(
      {
        switch: { success: sw.success, cancelled: sw.data?.cancelled, error: sw.error },
        sessionFile: st.sessionFile,
        messageCount: st.messageCount,
        getMessagesLength: msgs.length,
        byRole,
        rawEntryCount: rawEntries.length,
        rawMessageCount: rawMessages.length,
        gapVsRawMessages: rawMessages.length - st.messageCount,
        abortedAssistantInRawFile: abortedAssistant,
      },
      null,
      2
    )
  );
  const lower = st.messageCount < rawMessages.length;
  console.log(
    `\nRESULT: ${lower ? 'PASS' : 'FAIL'} (informational, not an error) -- live messageCount (${st.messageCount}) is ${lower ? '' : 'NOT '}lower than the raw source message count (${rawMessages.length})`
  );
} catch (e) {
  console.log('PROBE ERROR', e.message);
  console.log('\nRESULT: FAIL -- probe did not complete');
  exitCode = 1;
} finally {
  if (child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
  }
  // Quality-gate remediation (gate cycle 2, #449, PROJECT RULE): no `fs.rmSync` here anymore --
  // ROOT is a variable target, which AGENTS.md forbids passing to a recursive delete. Only
  // reported when `rootCreated` is true -- `fs.mkdtempSync` above is itself inside the `try`, so
  // a probe that fails before that call (the version check, or `mkdtempSync` itself failing on
  // an unwritable temp dir) never creates ROOT at all, and must not claim it left one on disk.
  if (rootCreated) {
    console.log(`\nscratch dir left on disk (not deleted -- delete manually when done): ${ROOT}`);
  }
}
process.exit(exitCode);
