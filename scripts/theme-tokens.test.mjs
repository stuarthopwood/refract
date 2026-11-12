import { describe, expect, it } from 'vitest';
import { parseColorLiteral } from './theme-tokens.mjs';

const BASE = { a: '#336699' };
const mix = (pct, props = BASE) => parseColorLiteral(`color-mix(in srgb, var(--a) ${pct}%, white)`, props);

describe('color-mix(in srgb, var(--x) P%, white)', () => {
  it('returns the base colour at 100%', () => {
    const base = parseColorLiteral('#336699', BASE);
    mix(100).linear.forEach((c, i) => expect(c).toBeCloseTo(base.linear[i], 6));
  });

  it('returns white at 0%', () => {
    mix(0).linear.forEach((c) => expect(c).toBeCloseTo(1, 6));
  });

  it('returns undefined for a self-referential token without overflowing', () => {
    expect(mix(50, { a: 'color-mix(in srgb, var(--a) 50%, white)' })).toBeUndefined();
  });

  it('returns undefined for a translucent base colour', () => {
    expect(mix(50, { a: 'color-mix(in oklab, var(--b) 50%, transparent)', b: '#336699' })).toBeUndefined();
  });

  it('returns undefined when the referenced token is missing', () => {
    expect(mix(50, { a: 'var(--nope)' })).toBeUndefined();
  });

  it.each(['abc', '1.', '.5', '-5', '150', '100.5'])('returns undefined for the malformed or out-of-range percentage %s', (pct) => {
    expect(mix(pct)).toBeUndefined();
  });
});
