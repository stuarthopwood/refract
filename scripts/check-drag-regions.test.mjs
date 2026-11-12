import { describe, expect, it } from 'vitest';
import { escapeRegExp } from './check-drag-regions-helpers.mjs';

describe('escapeRegExp', () => {
  it.each(['.', '*', '(', '\\', '+', '?', '[', ']', '{', '}', '|', '^', '$', ')'])('matches %s literally', (ch) => {
    const name = `Foo${ch}Bar`;
    expect(new RegExp(`^${escapeRegExp(name)}$`).test(name)).toBe(true);
  });

  it('does not let a dot match another character', () => {
    expect(new RegExp(`^${escapeRegExp('Motion.div')}$`).test('MotionXdiv')).toBe(false);
  });

  it('does not let a star act as a quantifier', () => {
    expect(new RegExp(`^${escapeRegExp('a*')}$`).test('aaa')).toBe(false);
  });

  it('escapes a backslash so it cannot escape the next character', () => {
    expect(new RegExp(`^${escapeRegExp('a\\d')}$`).test('a1')).toBe(false);
    expect(new RegExp(`^${escapeRegExp('a\\d')}$`).test('a\\d')).toBe(true);
  });

  it('produces a valid pattern for an unbalanced paren', () => {
    expect(() => new RegExp(escapeRegExp('X('))).not.toThrow();
  });
});
