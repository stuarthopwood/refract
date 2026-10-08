// Issue #455 quality-gate remediation (gate cycle 2 MEDIUM: "prove setModelRole keeps the read
// inside the queued task... mock execFile and resolveExecutable, slow first set, assert the
// second get is issued only after the first set callback runs, and that the second payload has
// both keys"). Mocks `node:child_process`'s `execFile` and `../process/executables`'
// `resolveExecutable` so these tests never spawn a real `omp` process; everything else
// (`node:fs/promises`'s `mkdir`/`readdir` for the scratch directory) runs for real against the OS
// temp directory, the same lightweight, idempotent calls the live code always makes.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
vi.mock('../process/executables', () => ({
  resolveExecutable: vi.fn(async () => 'C:/fake/omp.exe'),
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
