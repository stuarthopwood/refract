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
// Usage: node scripts/verify-tauri-record.mjs --out <path> [--timeout-ms 120000]
//
// Keep the scripted prompt tiny: this spends real model tokens against the ambient signed-in
// `omp` install (no --profile override, same as Refract itself never passing one -- see
// docs/spike/FINDINGS.md's "Production argv note").

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const out = { out: null, timeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  if (!out.out) throw new Error('verify-tauri-record: --out <path> is required');
  return out;
}

function nowMs() {
  return Date.now();
}

async function main() {
  const { out, timeoutMs } = parseArgs(process.argv.slice(2));
  const scratchCwd = mkdtempSync(path.join(tmpdir(), 'refract-r12a-capture-'));
  writeFileSync(out, '');
  const log = (direction, payload) => {
    appendFileSync(out, JSON.stringify({ t: nowMs(), direction, payload }) + '\n');
  };

  console.log(`verify-tauri-record: scratch cwd ${scratchCwd}`);
  console.log(`verify-tauri-record: writing raw capture to ${out}`);

  // No --profile, no --session-dir: ambient environment, exactly how Refract's own
  // OmpProcess.ts / omp::process spawn omp (contracts/omp-usage.md "Launch").
  const child = spawn('omp', ['--mode', 'rpc-ui', '--approval-mode=always-ask'], {
    cwd: scratchCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdoutBuf = '';
  const frameWaiters = [];
  const seenFrames = [];

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
          waiter.resolve(parsed);
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => log('stderr', chunk.toString('utf8')));
  child.on('exit', (code, signal) => log('exit', { code, signal }));

  function waitForFrame(predicate, timeout = 60_000) {
    const already = seenFrames.find(predicate);
    if (already) return Promise.resolve(already);
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

    send({ type: 'get_messages', id: 'r3' });
    await waitForFrame((f) => f.type === 'response' && f.id === 'r3', remaining());

    console.log('verify-tauri-record: scripted sequence complete, shutting down');
  } catch (err) {
    console.error('verify-tauri-record: scripted sequence failed:', err.message);
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
