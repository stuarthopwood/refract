#!/usr/bin/env node
// Records real `omp --mode rpc-ui` frames to a raw JSONL capture (both directions, tagged) that is
// hand-sanitised into the fixtures the fake `omp` replays (#795). Re-run when the wire protocol changes.
// The raw output can hold real chat text and must never be checked in.
//
// Usage: node scripts/verify-tauri-record.mjs --out <path> [--timeout-ms 120000] [--readiness]
// `--readiness` records the read-only `ipc/readiness.rs` probe (no model turn); the default
// capture spends real model tokens, so keep the scripted prompt tiny.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
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
  // Refuse an --out inside the repo so raw chat text cannot be committed. Compare realpaths of the
  // parent dir (the file may not exist yet) so symlinks/junctions, common under Windows TEMP, cannot fool it.
  const resolvedOut = path.resolve(out.out);
  const parentDir = path.dirname(resolvedOut);
  let realParent;
  try {
    realParent = realpathSync(parentDir);
  } catch {
    throw new Error(`verify-tauri-record: --out's parent directory does not exist: ${parentDir}`);
  }
  const realRepoRoot = realpathSync(REPO_ROOT);
  const relative = path.relative(realRepoRoot, realParent);
  const outside = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  if (!outside) {
    throw new Error(`verify-tauri-record: --out must resolve OUTSIDE the repository (got ${resolvedOut}, repo root ${realRepoRoot})`);
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

  // Ambient environment with no --profile, as Refract spawns omp; `--readiness` adds `--no-session`.
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
  // Frames at or after this index are unmatched; a later wait must not re-match a consumed frame.
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

  // Match only frames at or after `consumedIndex`, so the second `session_settled` wait does not
  // resolve on the first turn's frame; the first wait can still match a frame that arrived early.
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
      send({ type: 'get_available_models', id: 'r3' });
      await waitForFrame((f) => f.type === 'response' && f.id === 'r3', remaining());

      send({ type: 'get_login_providers', id: 'r4' });
      await waitForFrame((f) => f.type === 'response' && f.id === 'r4', remaining());

      console.log('verify-tauri-record: readiness sequence complete, shutting down');
    } else {
      // Tiny deterministic turn: one tool call, one approval, one short reply.
      send({
        type: 'prompt',
        id: 'p1',
        message: 'Use your write tool to create a file named note.txt containing just the word hi, then reply with the single word done.',
      });

      // Queued while the first is working, to capture queue_update.
      send({ type: 'prompt', id: 'p2', message: 'ping', streamingBehavior: 'followUp' });

      const approval = await waitForFrame((f) => f.type === 'extension_ui_request' && f.method === 'select' && String(f.title ?? '').startsWith('Allow tool:'), remaining());
      send({ type: 'extension_ui_response', id: approval.id, value: 'Approve' });

      await waitForFrame((f) => f.type === 'prompt_result' && f.id === 'p1', remaining());
      await waitForFrame((f) => f.type === 'session_settled', remaining());

      await waitForFrame((f) => f.type === 'prompt_result' && f.id === 'p2', remaining());
      await waitForFrame((f) => f.type === 'session_settled', remaining());

      // A local slash command: command_output, no model turn.
      send({ type: 'prompt', id: 'p3', message: '/tools' });
      await waitForFrame((f) => f.type === 'command_output', remaining()).catch(() => {});
      await waitForFrame((f) => f.type === 'response' && f.id === 'p3', remaining()).catch(() => {});

      // `get_messages_page` is what fetch_all_messages calls; `get_messages` is its fallback.
      send({ type: 'get_messages_page', id: 'r5', limit: 200 });
      await waitForFrame((f) => f.type === 'response' && f.id === 'r5', remaining());

      send({ type: 'get_messages', id: 'r6' });
      await waitForFrame((f) => f.type === 'response' && f.id === 'r6', remaining());

      console.log('verify-tauri-record: scripted sequence complete, shutting down');
    }
  } catch (err) {
    console.error('verify-tauri-record: scripted sequence failed:', err.message);
    // A failed capture must not exit 0 and leave a partial file that looks complete.
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
