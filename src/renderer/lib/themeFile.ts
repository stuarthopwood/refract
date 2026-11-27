// The one place that serialises a theme file, so every export carries `$schema` (#1885).
import { THEME_FORMAT_EXAMPLE_TOKENS, THEME_SCHEMA_URL } from '../../shared/themeSchema';

/** Theme file text: `$schema` first so editors pick up the schema, then the fields Rust validates. */
export function themeFileJson(name: string, base: string, tokens: Record<string, string>): string {
  return JSON.stringify({ $schema: THEME_SCHEMA_URL, version: 1, name, base, tokens }, null, 2) + '\n';
}

/** Export text for an installed custom theme; a seam so tests can pin the export shape without the Tauri bridge. */
export function customThemeJson(theme: { name: string; base: string; tokens: Record<string, string> }): string {
  return themeFileJson(theme.name, theme.base, theme.tokens);
}

/** The sample on the Theme file format help page. */
export const THEME_FORMAT_EXAMPLE = themeFileJson('Hot pink bubble', 'dark', THEME_FORMAT_EXAMPLE_TOKENS);
