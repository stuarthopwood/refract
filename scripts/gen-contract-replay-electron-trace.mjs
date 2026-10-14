// Contract-replay fixture generator (issue #795 part 3, R12b gate-round-2 remediation,
// MEDIUM #4): produces `scripts/fixtures/contract-replay/session-scenario.electron-trace.json`,
// the Electron-build counterpart to `session-scenario.rust-trace.json` (see
// `scripts/fixtures/contract-replay/README.md` for the normalization rules and why the two
// traces are compared the way `src-tauri/tests/contract_replay.rs` compares them).
//
// Gate-round-1 (PR #834) produced this fixture via a throwaway TS test (`src/main/ipc/
// contractReplay.test.ts`) that was written, run once to print its trace, hand-copied into the
// golden file, and then deleted (per AGENTS.md's "no new tests while prototyping" -- the #797
// Rust-ports exception does not cover this TS-side harness). Gate-round-2 flagged that as a
// squash-merge trap: once squashed into `main`, the commit holding that script is unreachable and
// no intermediate SHA is citable by a casual reader -- so this generator is checked in for real
// instead, under `scripts/` (never matched by `vitest.config.ts`'s own `include: ['src/**/
// *.test.ts']`, and not named `*.test.ts`/`*.spec.ts` either) so `pnpm test`/CI's `Vitest` step
// never auto-runs it.
//
// It still needs to run UNDER vitest (not plain `node`): `vi.mock('electron', ...)` is the only
// way to intercept `ipcMain.handle` without a real Electron app, and vitest's transform is what
// hoists that mock above this file's own static imports of `./repositories`/`./sessions`/
// `./chat` (which import `electron` themselves at module load time) -- a hoisting guarantee only
// vitest's test runner provides. Because this file lives outside `src/`, the project's own
// `vitest.config.ts` won't discover it even when named explicitly on the CLI (`include` is
// checked before CLI filters are applied) -- so it needs its own one-off config that widens
// `include` to this one file, checked in alongside it as
// `scripts/gen-contract-replay-electron-trace.vitest.config.mjs`.
//
// Regenerate (also documented in scripts/fixtures/contract-replay/README.md):
//   npx vitest run --config scripts/gen-contract-replay-electron-trace.vitest.config.mjs scripts/gen-contract-replay-electron-trace.mjs
//
// This OVERWRITES scripts/fixtures/contract-replay/session-scenario.electron-trace.json with the
// freshly captured, normalized trace. Eyeball the diff (if any) against
// scripts/fixtures/omp-frames/session.jsonl before committing -- this script does not itself
// judge correctness, only reproduces the one known-good capture procedure deterministically.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** @typedef {(...args: unknown[]) => unknown} Handler */
/** @type {Map<string, Handler>} */
const handlers = new Map();

// `vi.mock` factory calls are hoisted above every import in this file by vitest's own transform
// (the standard convention), so the static imports below -- including `../src/main/ipc/
// repositories`/`sessions`/`chat`, which import `electron` themselves at module load time -- see
// this mock already installed.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => {
      handlers.set(channel, fn);
    },
  },
  shell: { openPath: vi.fn() },
}));

const { registerRepositories } = await import('../src/main/ipc/repositories.ts');
const { registerSessions } = await import('../src/main/ipc/sessions.ts');
const { registerChat } = await import('../src/main/ipc/chat.ts');
const { SessionManager } = await import('../src/main/SessionManager.ts');
const { RegistryStore } = await import('../src/main/store/registry.ts');
const { SettingsStore } = await import('../src/main/store/settings.ts');
const { IPC_REQUESTS } = await import('../src/shared/ipc.ts');

const PROMPT_MESSAGE = "Create note.txt with the text 'hi', then tell me the token xyzzy9.";

function runGit(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Mirrors `src-tauri/tests/contract_replay.rs`'s own `make_scratch_repo`: one commit on `main`. */
function makeScratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'refract-contract-replay-repo-'));
  runGit(dir, ['init', '--initial-branch=main', '-q']);
  runGit(dir, ['config', 'user.email', 'contract-replay@example.invalid']);
  runGit(dir, ['config', 'user.name', 'contract-replay']);
  writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

/** Compiles `scripts/verify-tauri-omp-shim.rs` the same bare, non-Cargo way
 * `src-tauri/tests/contract_replay.rs`'s own `build_omp_shim` does -- reused verbatim here too,
 * since `OmpProcessOptions.ompPath` (unlike the Rust build) can point straight at it, with no
 * PATH-prepending needed. */
function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(REPO_ROOT, 'scripts', 'verify-tauri-omp-shim.rs');
  if (!existsSync(src)) throw new Error(`gen-contract-replay-electron-trace: expected shim source at ${src}`);
  const out = path.join(dir, 'omp.exe');
  execFileSync('rustc', ['--edition', '2021', '-O', src, '-o', out], { stdio: 'pipe' });
  return out;
}

/** Narrows a `Result<T>` envelope, the one controlled place this file ever reads `.value` off a
 * handler's return -- every call site below gets a plain, already-narrowed `T`, never an inline
 * cast-and-access. */
function expectOk(result) {
  if (!result.ok) throw new Error(`gen-contract-replay-electron-trace: expected ok:true, got ${JSON.stringify(result)}`);
  return result.value;
}

/** Integration-test exception (see this repo's own `ts-no-test-timers` rule): this polls a REAL
 * child process (the fake-omp Node script) advancing on the real system clock, including the
 * fixture's own genuine `{"__delay__": 2000}` pause between streamed deltas -- fake timers only
 * control this process's own JS-level timers, not the real wall-clock time a separate child
 * process's `setTimeout` needs to elapse, so deterministic time control is not possible here. */
async function waitForStatus(agent, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = agent.runtimeSnapshot.status;
    if (current === target) return;
    if (Date.now() >= deadline) {
      throw new Error(`gen-contract-replay-electron-trace: timed out after ${timeoutMs}ms waiting for status ${target} (last seen ${current})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** `handleTurnSettled`'s own `status` transition to `idle` can resolve before the trailing
 * coalesced `patch` flush (`PatchCoalescer`'s own 50ms debounce window, `patchCoalescer.ts`)
 * actually fires -- waiting on status alone is therefore not enough to know every event this
 * turn will ever emit has already landed. Waits for that flush's own observable effect (a
 * `patch` event whose ops include the assistant's final, non-streaming reply) instead of
 * guessing a fixed buffer past the idle transition. */
async function waitForFinalAssistantPatch(events, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.some(
      (event) =>
        event.type === 'patch' &&
        event.payload.ops.some((op) => op.op === 'upsert' && op.item.kind === 'assistant-text' && op.item.streaming === false),
    );
    if (found) return;
    if (Date.now() >= deadline) {
      throw new Error('gen-contract-replay-electron-trace: timed out waiting for the final assistant patch');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isIso8601Timestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

/** Epoch-ms bookkeeping fields this crate's own `SessionAgent.ts`/transcript code stamps from the
 * real wall clock, never supplied by the fixture tape itself -- normalized the same way the Rust
 * trace's `startedAt`/`endedAt`/`durationMs` are, plus `turnStartedAt` (spec 004, a field the
 * Rust port does not carry at all: subagents/readout are out of that slice's scope). */
const TIMING_KEYS = new Set(['startedAt', 'endedAt', 'durationMs', 'turnStartedAt']);

/** Same spirit as the Rust test's own `normalize`: replaces every run-to-run-nondeterministic
 * value (longest string first, so a longer match is substituted before a shorter one it happens
 * to contain can partially corrupt it). */
function normalize(value, dynamic) {
  if (typeof value === 'string') {
    let out = value;
    for (const [needle, placeholder] of dynamic) {
      if (needle.length > 0 && out.includes(needle)) out = out.split(needle).join(placeholder);
    }
    return isIso8601Timestamp(out) ? '<TIMESTAMP>' : out;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, dynamic));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (TIMING_KEYS.has(key) && inner !== null && inner !== undefined) {
        out[key] = '<TIMESTAMP_MS>';
        continue;
      }
      out[key] = normalize(inner, dynamic);
    }
    return out;
  }
  return value;
}

it(
  'regenerates the contract-replay Electron-build trace fixture',
  async () => {
    const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-contract-replay-shim-'));
    const ompPath = buildOmpShim(shimDir);
    const fakeOmpScript = path.join(REPO_ROOT, 'scripts', 'verify-tauri-fake-omp.mjs');
    if (!existsSync(fakeOmpScript)) throw new Error(`gen-contract-replay-electron-trace: expected fake-omp script at ${fakeOmpScript}`);
    process.env.REFRACT_FAKE_OMP_SCRIPT = fakeOmpScript;
    process.env.REFRACT_FAKE_OMP_NODE = process.execPath;
    process.env.REFRACT_FAKE_OMP_SCENARIO = 'session';

    const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-contract-replay-data-'));
    const registry = await RegistryStore.open(dataDir);
    const settings = await SettingsStore.open(dataDir);
    const manager = new SessionManager(registry, settings, ompPath);

    registerRepositories(manager, () => undefined);
    registerSessions(manager);
    registerChat(manager);

    const events = [];
    manager.onEvent((event) => events.push(event));

    const repoDir = makeScratchRepo();
    const steps = [];

    const addHandler = handlers.get(IPC_REQUESTS.REPOSITORIES_ADD);
    if (!addHandler) throw new Error(`gen-contract-replay-electron-trace: ${IPC_REQUESTS.REPOSITORIES_ADD} was never registered`);
    const addResponse = await addHandler({}, repoDir);
    const repository = expectOk(addResponse);
    steps.push({ kind: 'ipc', channel: IPC_REQUESTS.REPOSITORIES_ADD, args: repoDir, response: addResponse });

    const createHandler = handlers.get(IPC_REQUESTS.SESSIONS_CREATE);
    if (!createHandler) throw new Error(`gen-contract-replay-electron-trace: ${IPC_REQUESTS.SESSIONS_CREATE} was never registered`);
    const createArgs = { repositoryId: repository.id, baseBranch: 'main' };
    const createResponse = await createHandler({}, createArgs);
    const session = expectOk(createResponse);
    steps.push({ kind: 'ipc', channel: IPC_REQUESTS.SESSIONS_CREATE, args: [createArgs], response: createResponse });

    // Marks the Session visible BEFORE opening it (unlike the Rust test): this is the one extra
    // call needed on this side to get real `patch` (`TranscriptOp`) events forwarded at all
    // (`SessionManager.getOrCreateAgent`'s own `agent.on('patch', ...)` gate) -- the Rust test
    // instead reads a full snapshot via `runtime_view()` directly, sidestepping that gate
    // entirely (see README.md's "Known, intentional Rust-vs-Electron divergences" table).
    const setVisibleHandler = handlers.get(IPC_REQUESTS.SESSIONS_SET_VISIBLE);
    if (!setVisibleHandler) throw new Error(`gen-contract-replay-electron-trace: ${IPC_REQUESTS.SESSIONS_SET_VISIBLE} was never registered`);
    await setVisibleHandler({}, [session.id]);

    const agent = manager.getOrCreateAgent(session.id);

    const openHandler = handlers.get(IPC_REQUESTS.SESSIONS_OPEN);
    if (!openHandler) throw new Error(`gen-contract-replay-electron-trace: ${IPC_REQUESTS.SESSIONS_OPEN} was never registered`);
    const openResponse = await openHandler({}, session.id, true);
    steps.push({ kind: 'ipc', channel: IPC_REQUESTS.SESSIONS_OPEN, args: [session.id, true], response: openResponse });

    const sendHandler = handlers.get(IPC_REQUESTS.CHAT_SEND);
    if (!sendHandler) throw new Error(`gen-contract-replay-electron-trace: ${IPC_REQUESTS.CHAT_SEND} was never registered`);
    const sendResponse = await sendHandler({}, session.id, PROMPT_MESSAGE, undefined);
    steps.push({ kind: 'ipc', channel: IPC_REQUESTS.CHAT_SEND, args: [session.id, PROMPT_MESSAGE], response: sendResponse });

    await waitForStatus(agent, 'needs-you', 10_000);
    const pendingRequest = agent.runtimeSnapshot.pending[0];
    if (!pendingRequest) throw new Error('gen-contract-replay-electron-trace: expected a pending approval request');
    const requestId = pendingRequest.requestId;

    const answerHandler = handlers.get(IPC_REQUESTS.CHAT_ANSWER);
    if (!answerHandler) throw new Error(`gen-contract-replay-electron-trace: ${IPC_REQUESTS.CHAT_ANSWER} was never registered`);
    const answerArgs = { approve: true };
    const answerResponse = await answerHandler({}, session.id, requestId, answerArgs);
    steps.push({ kind: 'ipc', channel: IPC_REQUESTS.CHAT_ANSWER, args: [session.id, requestId, answerArgs], response: answerResponse });

    await waitForStatus(agent, 'idle', 15_000);
    await waitForFinalAssistantPatch(events, 5_000);

    // The real event stream captured via `SessionManager.onEvent` (not a reconstructed
    // snapshot): every `status`/`patch`/`request`/`requestResolved`/`list-changed` event this
    // run actually emitted, in order.
    steps.push({ kind: 'events', events });

    await agent.shutdown();

    const dynamic = [
      [session.worktreePath, '<WORKTREE_PATH>'],
      [repository.path, '<REPO_DIR>'],
      [repository.name, '<REPO_NAME>'],
      [session.branch, '<BRANCH_NAME>'],
      [session.id, '<SESSION_ID>'],
      [repository.id, '<REPO_ID>'],
    ].sort((a, b) => b[0].length - a[0].length);

    const trace = normalize(steps, dynamic);
    const goldenPath = path.join(REPO_ROOT, 'scripts', 'fixtures', 'contract-replay', 'session-scenario.electron-trace.json');
    const serialized = `${JSON.stringify(trace, null, 2)}\n`;
    const previous = existsSync(goldenPath) ? readFileSync(goldenPath, 'utf8') : undefined;
    writeFileSync(goldenPath, serialized);

    if (previous === serialized) {
      // eslint-disable-next-line no-console
      console.log(`gen-contract-replay-electron-trace: ${goldenPath} unchanged (regenerated trace is byte-identical).`);
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `gen-contract-replay-electron-trace: wrote ${goldenPath} -- DIFFERS from the previously committed file. ` +
          'Eyeball the diff against scripts/fixtures/omp-frames/session.jsonl before committing.',
      );
    }
  },
  30_000,
);
