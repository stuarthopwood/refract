// Where the theme file JSON Schema lives. `scripts/theme-schema.mjs` writes it into the schema's `$id`, and every exported theme file carries it as `$schema`.
export const THEME_SCHEMA_URL = 'https://raw.githubusercontent.com/stuarthopwood/refract/main/src/shared/theme.schema.json'

// The sample tokens on the Theme file format help page. They live here because they are example file content, not UI colours.
export const THEME_FORMAT_EXAMPLE_TOKENS: Record<string, string> = {
  'chat-user-bubble-bg': '#ff2d95',
  'chat-user-bubble-fg': '#ffffff',
  primary: 'oklch(0.7 0.2 350)',
}
