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

  // Quality-gate fix (security-auditor/test-reviewer, Medium, 2026-10-08): the old
  // `/[\x00-\x1f\x7f]/` missed every one of these; all three could spoof the displayed name.
  it('rejects a C1 control character', () => {
    expect(validateRepositoryName('bad\u0085name')).toMatch(/control characters/);
  });

  it('rejects a bidi override/isolate character', () => {
    expect(validateRepositoryName('bad\u202Ename')).toMatch(/control characters/);
  });

  it('rejects a line/paragraph separator', () => {
    expect(validateRepositoryName('bad\u2028name')).toMatch(/control characters/);
  });

  it('rejects a zero-width/format character', () => {
    expect(validateRepositoryName('bad\u200Bname')).toMatch(/control characters/);
  });

  // Quality-gate fix (cycle 2, 2026-10-08): U+200C/U+200D are `\p{Cf}` too, but excluded from
  // rejection -- both are required for legitimate text, not spoofing.
  it('accepts a zero-width joiner (emoji ZWJ sequence, e.g. a family emoji)', () => {
    expect(validateRepositoryName('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBeUndefined();
  });

  it('accepts a zero-width non-joiner (Persian/Indic script joining)', () => {
    expect(validateRepositoryName('\u0646\u200C\u0647')).toBeUndefined();
  });

  it('still rejects a genuine control character sitting next to a zero-width joiner', () => {
    expect(validateRepositoryName('bad\u200D\u0007name')).toMatch(/control characters/);
  });

  // Quality-gate fix (test-reviewer, Medium, 2026-10-08): counted in code points, not UTF-16 code
  // units -- a plain `.length` cap let through only 30 emoji (each a surrogate pair) before
  // rejecting, half the visible length of an ASCII name.
  it('accepts 60 emoji (60 code points, 120 UTF-16 code units)', () => {
    expect(validateRepositoryName('\u{1F600}'.repeat(MAX_REPOSITORY_NAME_LENGTH))).toBeUndefined();
  });

  it('rejects 61 emoji', () => {
    expect(validateRepositoryName('\u{1F600}'.repeat(MAX_REPOSITORY_NAME_LENGTH + 1))).toMatch(/too long/);
  });

  it('accepts a CJK name well under the limit', () => {
    expect(validateRepositoryName('\u91cd\u6784\u5de5\u4f5c\u533a')).toBeUndefined();
  });

  it('accepts a name with a combining mark (one grapheme, two code points)', () => {
    expect(validateRepositoryName('cafe\u0301')).toBeUndefined();
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
