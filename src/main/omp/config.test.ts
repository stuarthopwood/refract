// Issue #455 quality-gate remediation (test-reviewer MEDIUM: "nothing covers the parse and merge
// logic, which is pure and easy to test"). Covers the exported pure functions directly -- no `omp`
// invocation, no child_process mocking needed, matching this repo's existing
// `src/**/*.test.ts` vitest convention (node environment, see `vitest.config.ts`).
import { describe, expect, it } from 'vitest';
import {
  OmpConfigError,
  assertValidSelector,
  enqueueWrite,
  envWithoutRoleOverrides,
  mergeModelRole,
  parseCatalogResponse,
  rawModelRolesRecord,
  stringEntriesOnly,
} from './config';

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
  it('keeps non-blank string-valued entries', () => {
    const record = { task: 'anthropic/claude-sonnet-4-5', weird: ['a', 'b'], nested: { x: 1 } };
    expect(stringEntriesOnly(record)).toEqual({ task: 'anthropic/claude-sonnet-4-5' });
  });

  it('drops a blank or whitespace-only string entry (quality-gate a11y fix: never shown as "Inherited")', () => {
    const record = { task: 'anthropic/claude-sonnet-4-5', smol: '', slow: '   ' };
    expect(stringEntriesOnly(record)).toEqual({ task: 'anthropic/claude-sonnet-4-5' });
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

describe('mergeModelRole does not mutate its input', () => {
  it('setting a role leaves the original record object untouched', () => {
    const current = { task: 'old/value' };
    const snapshot = { ...current };
    mergeModelRole(current, 'smol', 'new/value');
    expect(current).toEqual(snapshot);
  });

  it('clearing a role leaves the original record object untouched', () => {
    const current = { task: 'old/value', smol: 'other/value' };
    const snapshot = { ...current };
    mergeModelRole(current, 'task', null);
    expect(current).toEqual(snapshot);
  });
});

describe('rawModelRolesRecord / mergeModelRole with a __proto__-named key', () => {
  it('treats "__proto__" as an ordinary own-enumerable string key, never polluting the prototype', () => {
    const input = JSON.parse('{"__proto__": {"task": "x"}}') as unknown;
    const raw = rawModelRolesRecord(input);
    // JSON.parse never creates a real [[Prototype]] link for a "__proto__" key -- it lands as an
    // ordinary own property -- so the spread in rawModelRolesRecord copies it as data, and the
    // global Object.prototype is never touched.
    expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).task).toBeUndefined();
    const merged = mergeModelRole(raw, 'task', 'anthropic/claude-sonnet-4-5');
    expect(merged.task).toBe('anthropic/claude-sonnet-4-5');
  });
});

describe('parseCatalogResponse keeps only the four fields this feature needs', () => {
  it('drops every extra live field (kind, contextWindow, cost, ...)', () => {
    const richRow = {
      provider: 'github-copilot',
      kind: 'chat',
      id: 'claude-fable-5',
      selector: 'github-copilot/claude-fable-5',
      name: 'Claude Fable 5',
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: true,
      thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
      input: ['text', 'image'],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      pricingStatus: 'fixed',
    };
    expect(parseCatalogResponse({ models: [richRow] })).toEqual([
      { provider: 'github-copilot', id: 'claude-fable-5', selector: 'github-copilot/claude-fable-5', name: 'Claude Fable 5' },
    ]);
  });
});

describe('assertValidSelector', () => {
  it('accepts an ordinary selector', () => {
    expect(() => assertValidSelector('anthropic/claude-sonnet-4-5')).not.toThrow();
  });

  it('accepts a selector with a thinking suffix', () => {
    expect(() => assertValidSelector('anthropic/claude-sonnet-4-5:high')).not.toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => assertValidSelector('')).toThrow(OmpConfigError);
  });

  it('rejects a whitespace-only string', () => {
    expect(() => assertValidSelector('   ')).toThrow(OmpConfigError);
  });

  it('accepts exactly 512 characters', () => {
    expect(() => assertValidSelector('a'.repeat(512))).not.toThrow();
  });

  it('rejects 513 characters', () => {
    try {
      assertValidSelector('a'.repeat(513));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OmpConfigError);
      expect((err as OmpConfigError).code).toBe('invalid-value');
    }
  });

  it('rejects a C0 control character', () => {
    expect(() => assertValidSelector('abc\u0000def')).toThrow(OmpConfigError);
  });

  it('rejects a newline', () => {
    expect(() => assertValidSelector('abc\ndef')).toThrow(OmpConfigError);
  });

  it('rejects DEL (U+007F)', () => {
    expect(() => assertValidSelector('abc\u007fdef')).toThrow(OmpConfigError);
  });

  it('rejects a C1 control character (U+0080-U+009F)', () => {
    expect(() => assertValidSelector('abc\u0085def')).toThrow(OmpConfigError);
  });

  it('rejects a zero-width space (U+200B)', () => {
    expect(() => assertValidSelector('abc\u200bdef')).toThrow(OmpConfigError);
  });

  it('rejects a bidi override character (U+202E)', () => {
    expect(() => assertValidSelector('abc\u202edef')).toThrow(OmpConfigError);
  });

  it('rejects a BOM (U+FEFF)', () => {
    expect(() => assertValidSelector('abc\ufeffdef')).toThrow(OmpConfigError);
  });
});

describe('envWithoutRoleOverrides', () => {
  it('strips an exact-case match', () => {
    const result = envWithoutRoleOverrides({ PI_SMOL_MODEL: 'x/y', OTHER: 'kept' });
    expect(result).toEqual({ OTHER: 'kept' });
  });

  it('strips a differently-cased match (Windows env names are case-insensitive)', () => {
    const result = envWithoutRoleOverrides({ Pi_Smol_Model: 'x/y', pi_config_files: 'a;b', OTHER: 'kept' });
    expect(result).toEqual({ OTHER: 'kept' });
  });

  it('strips all four documented variables', () => {
    const result = envWithoutRoleOverrides({
      PI_SMOL_MODEL: '1',
      PI_SLOW_MODEL: '2',
      PI_PLAN_MODEL: '3',
      PI_CONFIG_FILES: '4',
      KEPT: '5',
    });
    expect(result).toEqual({ KEPT: '5' });
  });

  it('leaves an empty environment empty', () => {
    expect(envWithoutRoleOverrides({})).toEqual({});
  });
});
