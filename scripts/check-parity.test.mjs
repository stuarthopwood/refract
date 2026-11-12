import { describe, expect, it } from 'vitest';
import { matchModAfterAttr } from './check-parity-helpers.mjs';

const OLD = /^(?:\s|\/\/[^\n]*)*mod\s+\w+\s*\{/;

const INPUTS = {
  'mod directly': 'mod tests {',
  'blank lines then mod': '\n\n  mod tests {\n}',
  'line comment then mod': '\n// note\nmod tests {',
  'two comments then mod': '\n// a\n// b\n  mod tests {',
  'mod with no space before brace': 'mod tests{',
  'declaration without body': 'mod tests;',
  'comment only': '\n// just a comment',
  'comment, no newline, mod on same line': '// c mod tests {',
  'fn after attribute': '\nfn helper() {}\nmod later {}',
  'empty': '',
};

// The old pattern backtracked into a comment and accepted `// c mod x {`; the new one does not.
const DIVERGES = new Set(['comment, no newline, mod on same line']);

describe('matchModAfterAttr', () => {
  for (const [name, text] of Object.entries(INPUTS)) {
    it(DIVERGES.has(name) ? `rejects what the old pattern wrongly accepted: ${name}` : `agrees with the previous pattern: ${name}`, () => {
      const oldMatch = OLD.exec(text);
      const newMatch = matchModAfterAttr(text);
      if (DIVERGES.has(name)) {
        expect(oldMatch).not.toBeNull();
        expect(newMatch).toBeNull();
        return;
      }
      expect(Boolean(newMatch)).toBe(Boolean(oldMatch));
      if (oldMatch) expect(newMatch[0]).toBe(oldMatch[0]);
    });
  }

  it('matches a mod block after comments and blank lines', () => {
    expect(matchModAfterAttr('\n// c\n\nmod tests {')?.[0].endsWith('{')).toBe(true);
  });

  it('rejects a bare declaration', () => {
    expect(matchModAfterAttr('mod tests;')).toBeNull();
  });

  // `// ` repeated with no newline backtracks exponentially in the old pattern (n=21 took ~40 s); the bound is loose on purpose.
  it('finishes quickly on input that is pathological for the old pattern', () => {
    const start = performance.now();
    expect(matchModAfterAttr('// '.repeat(20_000))).toBeNull();
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
