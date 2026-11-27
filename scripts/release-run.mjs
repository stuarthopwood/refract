// Process plumbing shared by `release.mjs` and `release-finish.mjs`: the repo root, command execution (every
// argv passes the main-push guard), SIGINT/SIGTERM handling and the one step runner both phases use.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_REPO_OWNER, assertNoMainPush } from './release-pr.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_SLUG = `${RELEASE_REPO_OWNER}/refract`;

export function fail(message) {
  throw new Error(message);
}

// Runs one command in the repo; returns its exit status and stdout (empty when `inherit` streams it).
export function exec(argv, { inherit = false } = {}) {
  assertNoMainPush(argv);
  const [cmd, ...rest] = argv;
  const result = spawnSync(cmd, rest, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'inherit'],
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

export function runCommand(argv) {
  if (exec(argv, { inherit: true }).status !== 0) fail(`${argv.join(' ')} failed`);
}

// Trimmed stdout of a command that must succeed.
export function capture(argv) {
  const { status, stdout } = exec(argv);
  if (status !== 0) fail(`${argv.join(' ')} failed`);
  return stdout.trim();
}

export function git(args) {
  return capture(['git', ...args]);
}

export function gitInherit(args) {
  runCommand(['git', ...args]);
}

// Both `pnpm release` and `pnpm release --finish` print the same plan under `--dry-run`, so the
// two phases can be reviewed before either writes anything.
export function printPlan(title, lines) {
  console.log(`\n${title}`);
  lines.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
}

export function worktreeDirFor(version) {
  return path.resolve(repoRoot, '..', `refract-release-v${version}`);
}

// Set by the SIGINT/SIGTERM handler installed before the first write. Without a handler Ctrl+C
// (sent to the whole process group) would kill this script mid-edit with no restore; with one, the
// child still dies, `spawnSync` returns non-zero and the catch block restores the files.
let interrupted = false;
let handlersInstalled = false;

export function installInterruptHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const onSignal = (signal) => {
    interrupted = true;
    console.error(`\nrelease: received ${signal}, stopping...`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// Thrown by `checkInterrupted` so catch sites can tell a user stop from an ordinary failure.
export class InterruptedError extends Error {}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

// `main()` is synchronous, so the signal handler only runs on a real event-loop tick: a catch block
// right after a failed `spawnSync` can still see `interrupted === false` after a real SIGINT. Awaiting
// `setImmediate` lets the queued handler run; called before every irreversible step.
export async function checkInterrupted() {
  await nextTick();
  if (interrupted) throw new InterruptedError('interrupted');
}

// Call from a catch block after `settleSignals()`, so a signal that killed the child has set the flag.
export function wasInterrupted(err) {
  return err instanceof InterruptedError || interrupted;
}

export async function settleSignals() {
  await nextTick();
}

// Runs one release step: an interrupt check first, then the action. On failure it prints the step's recovery
// message and exits (130 for a signal, 1 otherwise), so that message is the only thing the user sees.
export async function runStep(stepId, failureMessage, action) {
  try {
    await checkInterrupted();
    return await action();
  } catch (err) {
    await settleSignals();
    const stopped = wasInterrupted(err);
    console.error(failureMessage(stepId, { interrupted: stopped, detail: err.message }));
    process.exit(stopped ? 130 : 1);
  }
}
