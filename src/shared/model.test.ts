// Issue #455 quality-gate remediation (test-reviewer MEDIUM: "table tests for isModelRoleId/
// isCatalogKind covering a known value, '__proto__', '' and a non-string").
import { describe, expect, it } from 'vitest';
import { isCatalogKind, isModelRoleId } from './model';

describe('isModelRoleId', () => {
  it('accepts every known chat and model-kind role', () => {
    for (const role of ['default', 'smol', 'slow', 'vision', 'plan', 'commit', 'tiny', 'memory', 'task', 'advisor', 'image', 'web', 'speech', 'dictation', 'judge']) {
      expect(isModelRoleId(role)).toBe(true);
    }
  });

  it('rejects "__proto__"', () => {
    expect(isModelRoleId('__proto__')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isModelRoleId('')).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(isModelRoleId(42)).toBe(false);
    expect(isModelRoleId(null)).toBe(false);
    expect(isModelRoleId(undefined)).toBe(false);
    expect(isModelRoleId({})).toBe(false);
  });

  it('rejects an unknown role name', () => {
    expect(isModelRoleId('not-a-real-role')).toBe(false);
  });
});

describe('isCatalogKind', () => {
  it('accepts every known catalog kind', () => {
    for (const kind of ['chat', 'tiny', 'image', 'tts', 'stt', 'search', 'judge']) {
      expect(isCatalogKind(kind)).toBe(true);
    }
  });

  it('rejects "__proto__"', () => {
    expect(isCatalogKind('__proto__')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isCatalogKind('')).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(isCatalogKind(42)).toBe(false);
    expect(isCatalogKind(null)).toBe(false);
    expect(isCatalogKind(undefined)).toBe(false);
  });

  it('rejects an unknown kind name', () => {
    expect(isCatalogKind('not-a-real-kind')).toBe(false);
  });
});
