// Issue #455 quality-gate remediation (gate cycle 2 MEDIUM: "prove setModelRole keeps the read
// inside the queued task... mock execFile and resolveExecutable, slow first set, assert the
// second get is issued only after the first set callback runs, and that the second payload has
// both keys"). Mocks `node:child_process`'s `execFile` and `../process/executables`'
// `resolveExecutable` so these tests never spawn a real `omp` process; `node:fs/promises`'
// `access`/`mkdtemp`/`rmdir` (the scratch-directory calls, gate cycle 4 redesign -- see
// `config.ts`'s own module header) are mocked too, so these tests never depend on real filesystem
// timing or the real OS temp directory -- these were flaky under a full, heavily parallel
// test-suite run (many worker threads contending for CPU) when left real, even though they passed
// reliably in isolation. `access` always rejects by default, so `ensureScratchDir` takes the
// "create a fresh one" branch on every call in every test here, regardless of what an earlier
// test's `cachedScratchDir` module state left behind -- deliberately, so each test's own
// `mkdtemp` mock is always exercised rather than silently skipped by a stale cache hit.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
vi.mock('../process/executables', () => ({
  resolveExecutable: vi.fn(async () => 'C:/fake/omp.exe'),
}));
vi.mock('node:fs', () => ({
  promises: {
    access: vi.fn(),
    mkdtemp: vi.fn(),
    rmdir: vi.fn(),
  },
}));

// Imported AFTER the mocks above are registered (vitest hoists `vi.mock` calls, so this import
// always sees the mocked modules).
const { setModelRole, listCatalogModels, OmpConfigError } = await import('./config');

interface CapturedCall {
  file: string;
  args: string[];
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal };
  resolve(result: { error: Error | null; stdout?: string; stderr?: string }): void;
}

let calls: CapturedCall[];

beforeEach(() => {
  calls = [];
  execFileMock.mockReset();
  execFileMock.mockImplementation(
    (
      file: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      calls.push({
        file,
        args,
        options,
        resolve: (result) => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''),
      });
    }
  );
  vi.mocked(fsp.access).mockReset().mockRejectedValue(new Error('ENOENT'));
  vi.mocked(fsp.mkdtemp).mockReset().mockImplementation(async (prefix: string) => `${prefix}test123`);
  vi.mocked(fsp.rmdir).mockReset().mockResolvedValue(undefined);
});

/** Polls (no fixed sleep) until `predicate` is true or a bounded number of real event-loop turns
 * elapse. Uses `setImmediate`, never `setTimeout`/`setInterval` -- a sibling test file in this
 * project uses fake timers, which fake the latter but not the former, so this helper keeps
 * working whichever timer mode is active, and still yields real macrotask turns so pending real
 * I/O (the scratch-directory `mkdir`/`readdir` awaits inside `ompRaw`) gets a chance to settle
 * between checks. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('waitFor: condition never became true');
}

function argvOf(call: CapturedCall): string[] {
  return call.args;
}

/** `noUncheckedIndexedAccess` makes `calls[n]` a `CapturedCall | undefined`; this throws
 * immediately with a clear message instead of every call site needing its own `!`/guard. */
function nth(index: number): CapturedCall {
  const call = calls[index];
  if (!call) throw new Error(`expected a captured call at index ${index}, got ${calls.length} total`);
  return call;
}

describe('setModelRole keeps the whole read-merge-write inside the enqueued task', () => {
  it("a slow first set delays the second role's read until the first set settles, and the second write carries both keys", async () => {
    const firstSetModelRole = setModelRole('task', 'anthropic/claude-sonnet-4-5');

    // 1) First task's "config get modelRoles" (the merge-read).
    await waitFor(() => calls.length === 1);
    expect(argvOf(nth(0))).toEqual(['config', 'get', 'modelRoles', '--json']);
    nth(0).resolve({ error: null, stdout: JSON.stringify({ key: 'modelRoles', value: {}, type: 'record' }) });

    // 2) First task's "config set modelRoles" -- deliberately left UNRESOLVED (the "slow first
    // set") to prove the second call's own read cannot start until this settles.
    await waitFor(() => calls.length === 2);
    expect(argvOf(nth(1))[0]).toBe('config');
    expect(argvOf(nth(1))[1]).toBe('set');

    const secondSetModelRole = setModelRole('smol', 'openai/gpt-4.1-mini');

    // Give the second call every chance to (wrongly) start its own read while the first set is
    // still pending -- if the race this queue exists to close ever came back, a third call would
    // appear here.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.length).toBe(2);

    // Now let the first set settle.
    nth(1).resolve({ error: null, stdout: JSON.stringify({ key: 'modelRoles', value: { task: 'anthropic/claude-sonnet-4-5' } }) });

    // 3) First task's re-read after a successful set (`getModelRoles()`, full env).
    await waitFor(() => calls.length === 3);
    expect(argvOf(nth(2))).toEqual(['config', 'get', 'modelRoles', '--json']);
    nth(2).resolve({ error: null, stdout: JSON.stringify({ key: 'modelRoles', value: { task: 'anthropic/claude-sonnet-4-5' }, type: 'record' }) });

    const firstResult = await firstSetModelRole;
    expect(firstResult.roles).toEqual({ task: 'anthropic/claude-sonnet-4-5' });

    // 4) ONLY NOW does the second task's own merge-read start -- the queue's whole point.
    await waitFor(() => calls.length === 4);
    expect(argvOf(nth(3))).toEqual(['config', 'get', 'modelRoles', '--json']);
    nth(3).resolve({ error: null, stdout: JSON.stringify({ key: 'modelRoles', value: { task: 'anthropic/claude-sonnet-4-5' }, type: 'record' }) });

    // 5) Second task's "config set" -- the payload must carry BOTH keys (the first role's change,
    // read fresh after it landed, plus the new one), never a stale pre-first-write snapshot.
    await waitFor(() => calls.length === 5);
    expect(argvOf(nth(4))[0]).toBe('config');
    expect(argvOf(nth(4))[1]).toBe('set');
    const secondSetPayload = JSON.parse(argvOf(nth(4))[3] ?? '') as Record<string, string>;
    expect(secondSetPayload).toEqual({ task: 'anthropic/claude-sonnet-4-5', smol: 'openai/gpt-4.1-mini' });
    nth(4).resolve({
      error: null,
      stdout: JSON.stringify({ key: 'modelRoles', value: { task: 'anthropic/claude-sonnet-4-5', smol: 'openai/gpt-4.1-mini' } }),
    });

    await waitFor(() => calls.length === 6);
    nth(5).resolve({
      error: null,
      stdout: JSON.stringify({ key: 'modelRoles', value: { task: 'anthropic/claude-sonnet-4-5', smol: 'openai/gpt-4.1-mini' }, type: 'record' }),
    });

    const secondResult = await secondSetModelRole;
    expect(secondResult.roles).toEqual({ task: 'anthropic/claude-sonnet-4-5', smol: 'openai/gpt-4.1-mini' });
  });
});

describe('setModelRole rejects an unknown role before ever calling omp', () => {
  it('throws invalid-value and never calls execFile', async () => {
    await expect(setModelRole('not-a-real-role' as never, 'anthropic/claude-sonnet-4-5')).rejects.toMatchObject({
      code: 'invalid-value',
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('ompRaw error-code mapping (via listCatalogModels, a simpler single-call path)', () => {
  it('maps a nonzero exit with a string errno to a generic omp-failed (never the raw stderr in the message)', async () => {
    const promise = listCatalogModels('chat');
    await waitFor(() => calls.length === 1);
    const err = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    nth(0).resolve({ error: err, stdout: '', stderr: 'C:\\Users\\someone\\secret-looking-path\\config.yml: parse error' });
    try {
      await promise;
      expect.unreachable();
    } catch (caught) {
      expect(caught).toBeInstanceOf(OmpConfigError);
      expect((caught as InstanceType<typeof OmpConfigError>).code).toBe('omp-failed');
      // The raw stderr (which could contain a local path) must never reach the thrown message --
      // only main's own console.warn sees it (quality-gate remediation, security-auditor LOW).
      expect((caught as Error).message).not.toContain('secret-looking-path');
    }
  });

  it('rejects an invalid catalog kind before ever calling execFile', async () => {
    await expect(listCatalogModels('not-a-real-kind' as never)).rejects.toMatchObject({ code: 'invalid-value' });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('ensureScratchDir (gate cycle 4 redesign: fsp.mkdtemp, no emptiness check)', () => {
  it('a failing mkdtemp maps to a clear omp-failed error and never calls execFile', async () => {
    vi.mocked(fsp.mkdtemp).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    await expect(listCatalogModels('chat')).rejects.toMatchObject({
      code: 'omp-failed',
      message: 'Could not prepare a working directory for omp.',
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('reuses the cached scratch directory via access() when it still exists, without calling mkdtemp again', async () => {
    // First call: the default beforeEach mock has `access` reject, so this populates config.ts's
    // own module-level `cachedScratchDir` via a fresh `mkdtemp`.
    const first = listCatalogModels('chat');
    await waitFor(() => calls.length === 1);
    nth(0).resolve({ error: null, stdout: JSON.stringify({ models: [] }) });
    await first;
    expect(vi.mocked(fsp.mkdtemp)).toHaveBeenCalledTimes(1);

    // Second call: simulate the directory still existing (`access` resolves) -- `ensureScratchDir`
    // must reuse the cached path and never call `mkdtemp` again.
    vi.mocked(fsp.access).mockReset().mockResolvedValue(undefined);
    const second = listCatalogModels('chat');
    await waitFor(() => calls.length === 2);
    expect(vi.mocked(fsp.mkdtemp)).toHaveBeenCalledTimes(1);
    nth(1).resolve({ error: null, stdout: JSON.stringify({ models: [] }) });
    await second;
  });
});

describe('setModelRole strips role-override env vars from its own config set call, not only the merge-read', () => {
  const originalPiSmolModel = process.env['PI_SMOL_MODEL'];

  afterEach(() => {
    if (originalPiSmolModel === undefined) delete process.env['PI_SMOL_MODEL'];
    else process.env['PI_SMOL_MODEL'] = originalPiSmolModel;
  });

  it('neither the merge-read nor the config set call carries PI_SMOL_MODEL; the post-write re-read does', async () => {
    process.env['PI_SMOL_MODEL'] = 'probe/override-xyz';
    const promise = setModelRole('task', 'anthropic/claude-sonnet-4-5');

    await waitFor(() => calls.length === 1);
    expect(argvOf(nth(0))).toEqual(['config', 'get', 'modelRoles', '--json']);
    expect(nth(0).options.env['PI_SMOL_MODEL']).toBeUndefined();
    nth(0).resolve({ error: null, stdout: JSON.stringify({ key: 'modelRoles', value: {}, type: 'record' }) });

    await waitFor(() => calls.length === 2);
    expect(argvOf(nth(1))[1]).toBe('set');
    expect(nth(1).options.env['PI_SMOL_MODEL']).toBeUndefined();
    nth(1).resolve({ error: null, stdout: JSON.stringify({ key: 'modelRoles', value: { task: 'anthropic/claude-sonnet-4-5' } }) });

    // `getModelRoles()`'s own re-read is the TRUE effective value and deliberately does NOT strip
    // (config.ts's own module comment): it should carry the override through untouched.
    await waitFor(() => calls.length === 3);
    expect(argvOf(nth(2))).toEqual(['config', 'get', 'modelRoles', '--json']);
    expect(nth(2).options.env['PI_SMOL_MODEL']).toBe('probe/override-xyz');
    nth(2).resolve({ error: null, stdout: JSON.stringify({ key: 'modelRoles', value: { task: 'anthropic/claude-sonnet-4-5' }, type: 'record' }) });

    await promise;
  });
});
