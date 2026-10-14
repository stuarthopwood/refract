#!/usr/bin/env node
// Records real `omp --mode rpc-ui` frames into a raw JSONL capture, so the recorded-frame fake
// `omp` (scripts/verify-tauri-fake-omp.mjs) can be built from genuine wire shapes instead of
// guessed ones. Issue #795 part 2: "Record the frames from a real omp once; check them in as
// fixtures (counts and field names only, no chat text from real sessions)."
//
// This script is the "once" step: it talks to a REAL omp.exe (resolved from PATH, exactly how
// Refract itself resolves it) in a scratch cwd, sends a short scripted sequence of commands, and
// writes every line it saw (both directions) to --out as raw JSONL, each entry tagged with its
// direction so a human can sanitise it afterwards. It does not write to any fixture used by the
// harness directly: scripts/fixtures/omp-frames/*.jsonl are hand-sanitised from this output
// (real chat text replaced with placeholders, field names and counts kept) and checked in
// separately. Re-run this whenever the wire protocol changes (a new omp version, a new frame
// type Refract starts depending on) to re-verify the fixtures still match reality.
//
// Usage: node scripts/verify-tauri-record.mjs --out <path> [--timeout-ms 120000] [--readiness]
//
// `--readiness` records the scratch, non-session probe `ipc/readiness.rs`'s `check_omp_signed_in`
// runs (`--no-session`, `get_state`/`get_available_models`/`get_login_providers`, no model turn,
// no prompt) instead of the default chat-turn capture -- this backs `readiness.jsonl`.
//
// Keep the scripted prompt tiny: this spends real model tokens against the ambient signed-in
// `omp` install (no --profile override, same as Refract itself never passing one -- see
// docs/spike/FINDINGS.md's "Production argv note"). `--readiness` spends none (read-only RPC).

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { out: null, timeoutMs: 120_000, readiness: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (argv[i] === '--readiness') out.readiness = true;
  }
  if (!out.out) throw new Error('verify-tauri-record: --out <path> is required');
  // Gate-fix (security review LOW): the raw capture can carry real chat text and real `omp`
  // stderr -- refuse a destination inside this repository so it can never land in a commit by
  // accident (fixtures are hand-sanitised separately; the raw file itself must never be checked
  // in, per this file's own header).
  const resolvedOut = path.resolve(out.out);
  const relative = path.relative(REPO_ROOT, resolvedOut);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`verify-tauri-record: --out must resolve OUTSIDE the repository (got ${resolvedOut}, repo root ${REPO_ROOT})`);
  }
  return out;
}

function nowMs() {
  return Date.now();
}

async function main() {
  const { out, timeoutMs, readiness } = parseArgs(process.argv.slice(2));
  const scratchCwd = mkdtempSync(path.join(tmpdir(), 'refract-r12a-capture-'));
  writeFileSync(out, '');
  const log = (direction, payload) => {
    appendFileSync(out, JSON.stringify({ t: nowMs(), direction, payload }) + '\n');
  };

  console.log(`verify-tauri-record: scratch cwd ${scratchCwd}`);
  console.log(`verify-tauri-record: writing raw capture to ${out}`);

  // No --profile, no --session-dir: ambient environment, exactly how Refract's own
  // OmpProcess.ts / omp::process spawn omp (contracts/omp-usage.md "Launch"). `--readiness`
  // adds `--no-session`, matching `ipc/readiness.rs`'s own scratch, non-Session `OmpProcess`.
  const spawnArgs = ['--mode', 'rpc-ui', '--approval-mode=always-ask'];
  if (readiness) spawnArgs.push('--no-session');
  const child = spawn('omp', spawnArgs, {
    cwd: scratchCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdoutBuf = '';
  const frameWaiters = [];
  const seenFrames = [];
  // Advances past every frame a `waitForFrame` call has ever matched (whether found already
  // cached or newly arrived), so a later wait can never re-match a frame an earlier wait already
  // consumed (see `waitForFrame`'s own comment for the bug this closes).
  let consumedIndex = 0;

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      log('frame', parsed);
      seenFrames.push(parsed);
      for (const waiter of [...frameWaiters]) {
        if (waiter.predicate(parsed)) {
          frameWaiters.splice(frameWaiters.indexOf(waiter), 1);
          consumedIndex = seenFrames.length;
          waiter.resolve(parsed);
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => log('stderr', chunk.toString('utf8')));
  child.on('exit', (code, signal) => log('exit', { code, signal }));

  // Gate-fix (code review MEDIUM): matches only a frame at or after `consumedIndex` -- never a
  // frame an EARLIER wait already consumed. A plain `seenFrames.find(predicate)` fast path here
  // used to make the second `session_settled` wait resolve instantly against the FIRST turn's
  // already-seen settle frame instead of waiting for the second turn's own one; this still lets
  // the very first wait (for `ready`) match a frame that beat its own `await` to arrive, since
  // nothing has consumed it yet.
  function waitForFrame(predicate, timeout = 60_000) {
    const alreadyIndex = seenFrames.slice(consumedIndex).findIndex(predicate);
    if (alreadyIndex >= 0) {
      consumedIndex = consumedIndex + alreadyIndex + 1;
      return Promise.resolve(seenFrames[consumedIndex - 1]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = frameWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) frameWaiters.splice(idx, 1);
        reject(new Error(`verify-tauri-record: timed out waiting for a matching frame after ${timeout}ms`));
      }, timeout);
      frameWaiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  function send(command) {
    log('sent', command);
    child.stdin.write(JSON.stringify(command) + '\n');
  }

  const overallDeadline = nowMs() + timeoutMs;
  function remaining() {
    return Math.max(1000, overallDeadline - nowMs());
  }

  try {
    await waitForFrame((f) => f.type === 'ready', remaining());

    send({ type: 'negotiate_protocol', id: 'r1', protocolVersion: 2 });
    await waitForFrame((f) => f.type === 'response' && f.id === 'r1', remaining());

    send({ type: 'get_state', id: 'r2' });
    await waitForFrame((f) => f.type === 'response' && f.id === 'r2', remaining());

    if (readiness) {
      // Matches `ipc/readiness.rs`'s own `probe_signed_in`/`signed_in_failure_hint` sequence
      // exactly: no model turn, no `prompt`, read-only RPC only.
      send({ type: 'get_available_models', id: 'r3' });
      await waitForFrame((f) => f.type === 'response' && f.id === 'r3', remaining());

      send({ type: 'get_login_providers', id: 'r4' });
      await waitForFrame((f) => f.type === 'response' && f.id === 'r4', remaining());

      console.log('verify-tauri-record: readiness sequence complete, shutting down');
    } else {
      // Tiny scripted turn: one tool call (write), one approval, one short reply. Keep the
      // instruction short and deterministic -- this is a fixture capture, not a real task.
      send({
        type: 'prompt',
        id: 'p1',
        message: 'Use your write tool to create a file named note.txt containing just the word hi, then reply with the single word done.',
      });

      // Queue a second message while the first is still working, to capture queue_update.
      send({ type: 'prompt', id: 'p2', message: 'ping', streamingBehavior: 'followUp' });

      // Approve the write-tool approval dialog as soon as it appears.
      const approval = await waitForFrame((f) => f.type === 'extension_ui_request' && f.method === 'select' && String(f.title ?? '').startsWith('Allow tool:'), remaining());
      send({ type: 'extension_ui_response', id: approval.id, value: 'Approve' });

      // First turn settles.
      await waitForFrame((f) => f.type === 'prompt_result' && f.id === 'p1', remaining());
      await waitForFrame((f) => f.type === 'session_settled', remaining());

      // Second (queued) turn settles.
      await waitForFrame((f) => f.type === 'prompt_result' && f.id === 'p2', remaining());
      await waitForFrame((f) => f.type === 'session_settled', remaining());

      // A local slash command (agentInvoked:false, no model turn): command_output.
      send({ type: 'prompt', id: 'p3', message: '/tools' });
      await waitForFrame((f) => f.type === 'command_output', remaining()).catch(() => {});
      await waitForFrame((f) => f.type === 'response' && f.id === 'p3', remaining()).catch(() => {});

      // `get_messages_page` is what `session::agent::fetch_all_messages` actually calls
      // (`MESSAGES_PAGE_SIZE`, 200); `get_messages` is the fallback it uses only if the first
      // page fails, captured too since earlier fixture drafts used it directly.
      send({ type: 'get_messages_page', id: 'r5', limit: 200 });
      await waitForFrame((f) => f.type === 'response' && f.id === 'r5', remaining());

      send({ type: 'get_messages', id: 'r6' });
      await waitForFrame((f) => f.type === 'response' && f.id === 'r6', remaining());

      console.log('verify-tauri-record: scripted sequence complete, shutting down');
    }
  } catch (err) {
    console.error('verify-tauri-record: scripted sequence failed:', err.message);
    // Gate-fix (code review MEDIUM): a failed capture used to still exit 0, leaving a partial
    // raw file that looks complete to anything checking only the process's own exit code.
    process.exitCode = 1;
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
