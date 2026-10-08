// Issue #480 point 5 (validation) and point 4 (reset to folder name): regression coverage.
import { describe, it, expect } from 'vitest';
import { MAX_REPOSITORY_NAME_LENGTH, resolveRepositoryName, validateRepositoryName } from './repositoryName';

describe('validateRepositoryName', () => {
  it('accepts an ordinary name', () => {
    expect(validateRepositoryName('Refract')).toBeUndefined();
  });

  it('accepts a name at exactly the maximum length', () => {
    expect(validateRepositoryName('x'.repeat(MAX_REPOSITORY_NAME_LENGTH))).toBeUndefined();
  });

  it('rejects a name over the maximum length', () => {
    expect(validateRepositoryName('x'.repeat(MAX_REPOSITORY_NAME_LENGTH + 1))).toMatch(/too long/);
  });

  it('rejects control characters', () => {
    expect(validateRepositoryName('bad\u0007name')).toMatch(/control characters/);
    expect(validateRepositoryName('bad\nname')).toMatch(/control characters/);
  });

  it('accepts an empty string (reset is handled by resolveRepositoryName, not an error here)', () => {
    expect(validateRepositoryName('')).toBeUndefined();
  });
});

describe('resolveRepositoryName', () => {
  it('keeps the trimmed name when non-empty', () => {
    expect(resolveRepositoryName('Refract', 'pinion')).toBe('Refract');
  });

  it('resets to the folder basename when the trimmed name is empty', () => {
    expect(resolveRepositoryName('', 'pinion')).toBe('pinion');
  });
});
