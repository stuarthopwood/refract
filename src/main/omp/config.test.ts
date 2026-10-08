// Issue #455 quality-gate remediation (test-reviewer MEDIUM: "nothing covers the parse and merge
// logic, which is pure and easy to test"). Covers the exported pure functions directly -- no `omp`
// invocation, no child_process mocking needed, matching this repo's existing
// `src/**/*.test.ts` vitest convention (node environment, see `vitest.config.ts`).
import { describe, expect, it } from 'vitest';
import { OmpConfigError, enqueueWrite, mergeModelRole, parseCatalogResponse, rawModelRolesRecord, stringEntriesOnly } from './config';

describe('rawModelRolesRecord', () => {
  it('returns an empty record for null', () => {
    expect(rawModelRolesRecord(null)).toEqual({});
  });

  it('returns an empty record for undefined', () => {
    expect(rawModelRolesRecord(undefined)).toEqual({});
  });

  it('returns a shallow copy of a plain object, preserving non-string entries', () => {
    const input = { task: 'anthropic/claude-sonnet-4-5', weird: ['a', 'b'], nested: { x: 1 } };
    const result = rawModelRolesRecord(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('throws parse-failed for an array', () => {
    expect(() => rawModelRolesRecord(['not', 'a', 'record'])).toThrow(OmpConfigError);
    try {
      rawModelRolesRecord([]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OmpConfigError);
      expect((err as OmpConfigError).code).toBe('parse-failed');
    }
  });

  it('throws parse-failed for a non-object scalar', () => {
    expect(() => rawModelRolesRecord('nope')).toThrow(OmpConfigError);
    expect(() => rawModelRolesRecord(42)).toThrow(OmpConfigError);
  });
});

describe('stringEntriesOnly', () => {
  it('keeps only string-valued entries', () => {
    const record = { task: 'anthropic/claude-sonnet-4-5', weird: ['a', 'b'], nested: { x: 1 }, empty: '' };
    expect(stringEntriesOnly(record)).toEqual({ task: 'anthropic/claude-sonnet-4-5', empty: '' });
  });

  it('returns an empty record when every entry is non-string', () => {
    expect(stringEntriesOnly({ a: 1, b: null })).toEqual({});
  });

  it('returns an empty record for an empty input', () => {
    expect(stringEntriesOnly({})).toEqual({});
  });
});

describe('mergeModelRole', () => {
  it('sets a role on an empty record', () => {
    expect(mergeModelRole({}, 'task', 'anthropic/claude-sonnet-4-5')).toEqual({ task: 'anthropic/claude-sonnet-4-5' });
  });

  it('overwrites an existing role, leaving other keys untouched', () => {
    const current = { task: 'old/value', smol: 'openai/gpt-4.1-mini' };
    expect(mergeModelRole(current, 'task', 'new/value')).toEqual({ task: 'new/value', smol: 'openai/gpt-4.1-mini' });
  });

  it('preserves a non-string entry it does not understand when setting a different role', () => {
    const current = { task: 'anthropic/claude-sonnet-4-5', weird: ['a', 'b'] };
    expect(mergeModelRole(current, 'smol', 'openai/gpt-4.1-mini')).toEqual({
      task: 'anthropic/claude-sonnet-4-5',
      weird: ['a', 'b'],
      smol: 'openai/gpt-4.1-mini',
    });
  });

  it('clears an existing role by deleting its key', () => {
    const current = { task: 'anthropic/claude-sonnet-4-5', smol: 'openai/gpt-4.1-mini' };
    expect(mergeModelRole(current, 'task', null)).toEqual({ smol: 'openai/gpt-4.1-mini' });
  });

  it('clearing the last role returns an empty record', () => {
    expect(mergeModelRole({ task: 'anthropic/claude-sonnet-4-5' }, 'task', null)).toEqual({});
  });

  it('clearing an already-absent role returns the SAME object reference (no-op write)', () => {
    const current = { smol: 'openai/gpt-4.1-mini' };
    const result = mergeModelRole(current, 'task', null);
    expect(result).toBe(current);
  });
});

describe('parseCatalogResponse', () => {
  const validRow = { provider: 'anthropic', id: 'claude-sonnet-4-5', selector: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' };

  it('accepts a bare top-level array', () => {
    expect(parseCatalogResponse([validRow])).toEqual([validRow]);
  });

  it('accepts the documented { models: [...] } wrapper', () => {
    expect(parseCatalogResponse({ models: [validRow] })).toEqual([validRow]);
  });

  it('accepts an empty { models: [] } (a fresh profile with zero available models)', () => {
    expect(parseCatalogResponse({ models: [] })).toEqual([]);
  });

  it('drops a row missing a required field', () => {
    const incomplete = { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' };
    expect(parseCatalogResponse({ models: [incomplete, validRow] })).toEqual([validRow]);
  });

  it('drops a row whose fields are the wrong type', () => {
    const wrongTypes = { provider: 1, id: 'x', selector: 'x/x', name: 'X' };
    expect(parseCatalogResponse({ models: [wrongTypes] })).toEqual([]);
  });

  it('drops a null or non-object row', () => {
    expect(parseCatalogResponse({ models: [null, 'nope', 42, validRow] })).toEqual([validRow]);
  });

  it('throws parse-failed for a shape that is neither a bare array nor { models: [...] }', () => {
    try {
      parseCatalogResponse({ roles: [] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OmpConfigError);
      expect((err as OmpConfigError).code).toBe('parse-failed');
    }
  });

  it('throws parse-failed for garbage input', () => {
    expect(() => parseCatalogResponse(null)).toThrow(OmpConfigError);
    expect(() => parseCatalogResponse('garbage')).toThrow(OmpConfigError);
    expect(() => parseCatalogResponse(42)).toThrow(OmpConfigError);
  });
});

// Quality-gate remediation (code-reviewer/security-auditor HIGH): "concurrent role changes can
// silently lose a write" -- this proves the serialisation guarantee `setModelRole` relies on
// (`enqueueWrite`) directly, without spawning the real `omp` CLI: two tasks representing
// independent read-merge-write cycles must run strictly one after the other, never overlapping,
// even when the first is slower than the second.
describe('enqueueWrite', () => {
  it('runs two queued tasks strictly in enqueue order, never overlapping', async () => {
    const events: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const taskA = enqueueWrite(async () => {
      events.push('A-start');
      await delay(20);
      events.push('A-end');
      return 'A';
    });
    const taskB = enqueueWrite(async () => {
      events.push('B-start');
      await delay(1);
      events.push('B-end');
      return 'B';
    });

    const [resultA, resultB] = await Promise.all([taskA, taskB]);
    expect(resultA).toBe('A');
    expect(resultB).toBe('B');
    // B's task body must not even START until A's has fully finished -- if the two raced (the
    // bug this queue exists to close), B-start would appear before A-end.
    expect(events).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('a failed task never wedges later queued work behind a permanently-rejected chain', async () => {
    const failing = enqueueWrite(async () => {
      throw new Error('simulated omp failure');
    });
    await expect(failing).rejects.toThrow('simulated omp failure');

    const after = enqueueWrite(async () => 'still works');
    await expect(after).resolves.toBe('still works');
  });
});
