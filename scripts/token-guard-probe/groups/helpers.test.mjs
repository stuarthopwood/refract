import { describe, expect, it } from 'vitest';
import { nest } from './helpers.mjs';

describe('nest', () => {
  it('turns dotted keys into the nested shape config.yml stores', () => {
    expect(nest({ 'a.b': 1, 'c.d.e': 2, 'a.f': 3 })).toEqual({ a: { b: 1, f: 3 }, c: { d: { e: 2 } } });
  });

  it('keeps an undotted key at the top level', () => {
    expect(nest({ top: true })).toEqual({ top: true });
  });
});
