// The one place that serialises a theme file, so every export carries `$schema` (#1885).
import { THEME_SCHEMA_URL } from '../../shared/themeSchema';

/** Theme file text: `$schema` first so editors pick up the schema, then the fields Rust validates. */
export function themeFileJson(name: string, base: string, tokens: Record<string, string>): string {
  return JSON.stringify({ $schema: THEME_SCHEMA_URL, version: 1, name, base, tokens }, null, 2) + '\n';
}

/** The sample on the Theme file format help page. */
export const THEME_FORMAT_EXAMPLE = themeFileJson('Hot pink bubble', 'dark', {
  'chat-user-bubble-bg': '#ff2d95',
  'chat-user-bubble-fg': '#ffffff',
  primary: 'oklch(0.7 0.2 350)',
});
