import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildThemeSchema, renderThemeSchema, SCHEMA_PATH } from './theme-schema.mjs';

const tokens = JSON.parse(readFileSync(new URL('../src/shared/theme-tokens.json', import.meta.url), 'utf8')).tokens;
const docsPath = new URL('../src/shared/theme-token-docs.json', import.meta.url);

describe('theme file JSON Schema (#1885)', () => {
  it('lists every token in theme-tokens.json, each with a layer and a description', () => {
    const schema = buildThemeSchema();
    expect(Object.keys(schema.properties.tokens.properties)).toEqual(tokens);
    for (const prop of Object.values(schema.properties.tokens.properties)) {
      expect(['semantic', 'component']).toContain(prop['x-refract-layer']);
      expect(prop.description.length).toBeGreaterThan(20);
    }
  });

  it('is the committed src/shared/theme.schema.json; run `pnpm theme-schema` after changing a token', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n')).toBe(renderThemeSchema());
  });

  it('documents exactly the tokens in theme-tokens.json', () => {
    const docs = JSON.parse(readFileSync(docsPath, 'utf8'));
    expect(Object.keys(docs).sort()).toEqual([...tokens].sort());
  });

  it('rejects unknown properties at the top level and under tokens', () => {
    const schema = buildThemeSchema();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.tokens.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['version', 'name', 'base', 'tokens']);
  });

  it('accepts the colour grammar the Rust validator accepts and rejects what it rejects', () => {
    const colour = new RegExp(buildThemeSchema().definitions.colour.pattern);
    for (const ok of ['#fff', '#ffff', '#1f6feb', '#1f6feb80', 'transparent', 'rgb(0 0 0)', 'rgba(0, 0, 0, 0.5)', 'oklch(0.7 0.15 250 / 50%)', 'hsl(210 50% 40%)']) {
      expect(colour.test(ok), ok).toBe(true);
    }
    for (const bad of ['red', '#ff', '#fffff', 'var(--x)', 'calc(1)', 'color-mix(in srgb, red, blue)', 'rgb(1 2)', 'rgb(a b c)']) {
      expect(colour.test(bad), bad).toBe(false);
    }
  });
});
