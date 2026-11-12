import { describe, expect, it } from 'vitest';
import { matchModAfterAttr } from './check-parity-helpers.mjs';

// Expected leading match text per input, or null when no `mod x {` block follows.
const CASES = {
  'mod directly': ['mod tests {', 'mod tests {'],
  'blank lines then mod': ['\n\n  mod tests {\n}', '\n\n  mod tests {'],
  'line comment then mod': ['\n// note\nmod tests {', '\n// note\nmod tests {'],
  'two comments then mod': ['\n// a\n// b\n  mod tests {', '\n// a\n// b\n  mod tests {'],
  'mod with no space before brace': ['mod tests{', 'mod tests{'],
  'declaration without body': ['mod tests;', null],
  'comment only': ['\n// just a comment', null],
  // A comment runs to end of line, so a same-line `mod` is part of the comment.
  'comment, no newline, mod on same line': ['// c mod tests {', null],
  'fn after attribute': ['\nfn helper() {}\nmod later {}', null],
  'empty': ['', null],
};

describe('matchModAfterAttr', () => {
  for (const [name, [text, expected]] of Object.entries(CASES)) {
    it(`${expected === null ? 'rejects' : 'matches'}: ${name}`, () => {
      const match = matchModAfterAttr(text);
      if (expected === null) expect(match).toBeNull();
      else expect(match[0]).toBe(expected);
    });
  }

  it('matches a mod block after comments and blank lines', () => {
    expect(matchModAfterAttr('\n// c\n\nmod tests {')?.[0].endsWith('{')).toBe(true);
  });

  it('rejects a bare declaration', () => {
    expect(matchModAfterAttr('mod tests;')).toBeNull();
  });

  // Repeated `// ` with no newline must not backtrack; a 100 ms bound catches exponential behaviour without flaking.
  it('finishes quickly on backtracking-prone input', () => {
    const input = '// '.repeat(18);
    const start = performance.now();
    expect(matchModAfterAttr(input)).toBeNull();
    expect(performance.now() - start).toBeLessThan(100);
  });
});
