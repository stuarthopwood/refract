// Builds the theme file JSON Schema (#1885) from the token allowlist, the per-token docs and the built-in preset ids,
// so the schema cannot list a token the validator rejects or miss one it accepts. `pnpm theme-schema` rewrites it.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA_PATH = path.join(repoRoot, 'src/shared/theme.schema.json')
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

// Mirrors `is_valid_colour` in src-tauri/src/store/theme_files.rs: hex, `transparent`, or rgb/hsl/oklch with numeric arguments.
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|deg)?'
const COLOUR_PATTERN =
  `^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent|(?:rgba?|hsla?|oklch)\\(\\s*${NUMBER}(?:[\\s,/]+${NUMBER}){2,3}\\s*\\))$`

export function readSchemaUrl() {
  const match = read('src/shared/themeSchema.ts').match(/THEME_SCHEMA_URL\s*=\s*'([^']+)'/)
  if (!match) throw new Error('src/shared/themeSchema.ts must export THEME_SCHEMA_URL as a string literal')
  return match[1]
}

/** The built-in preset ids a file may name as `base`, read from the `ThemeId` union in `themes.ts`. */
export function readBaseIds() {
  const union = read('src/shared/themes.ts').match(/export type ThemeId =([^]*?)\r?\n\r?\n/)
  const ids = union ? [...union[1].matchAll(/\|\s*'([a-z0-9-]+)'/g)].map((m) => m[1]) : []
  if (ids.length === 0) throw new Error('could not read the ThemeId union from src/shared/themes.ts')
  return ids
}

export function buildThemeSchema() {
  const tokens = JSON.parse(read('src/shared/theme-tokens.json')).tokens
  const docs = JSON.parse(read('src/shared/theme-token-docs.json'))
  const missing = tokens.filter((token) => !docs[token])
  if (missing.length > 0) {
    throw new Error(`theme-token-docs.json has no layer and description for: ${missing.join(', ')}`)
  }
  const stale = Object.keys(docs).filter((token) => !tokens.includes(token))
  if (stale.length > 0) {
    throw new Error(`theme-token-docs.json documents tokens that theme-tokens.json no longer lists: ${stale.join(', ')}`)
  }
  const properties = {}
  for (const token of tokens) {
    const { layer, description } = docs[token]
    if (layer !== 'semantic' && layer !== 'component') throw new Error(`${token}: layer must be "semantic" or "component"`)
    properties[token] = {
      $ref: '#/definitions/colour',
      description: `${layer === 'semantic' ? 'Semantic role' : 'Component'} token. ${description}`,
      'x-refract-layer': layer,
    }
  }
  const url = readSchemaUrl()
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: url,
    title: 'Refract theme file',
    description:
      'A custom Refract theme: a built-in preset (base) plus colour overrides. Any token the file leaves out falls back to base.',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'name', 'base', 'tokens'],
    properties: {
      $schema: { type: 'string', description: 'Where this schema lives; editors use it for autocomplete and validation.' },
      version: { const: 1, description: 'The file format version. Always 1.' },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 40,
        pattern: "^[A-Za-z0-9_()._-](?:[A-Za-z0-9 _()._-]*[A-Za-z0-9_()._-])?$",
        description: 'Shown in the theme list. 1 to 40 letters, digits, spaces, dashes, dots or brackets, with no leading or trailing space.',
      },
      base: { enum: readBaseIds(), description: 'The built-in theme this file starts from; tokens the file omits take its values.' },
      tokens: {
        type: 'object',
        additionalProperties: false,
        description: 'Colour overrides keyed by token name, without the leading "--". Leave out any token you do not want to change.',
        properties,
      },
    },
    definitions: {
      colour: {
        type: 'string',
        maxLength: 64,
        pattern: COLOUR_PATTERN,
        description: 'A hex colour (3, 4, 6 or 8 digits), transparent, or rgb(), hsl() or oklch() with numeric arguments.',
        examples: ['#1f6feb', 'oklch(0.7 0.15 250)', 'rgb(31 111 235 / 50%)'],
      },
    },
  }
}

export function renderThemeSchema() {
  return `${JSON.stringify(buildThemeSchema(), null, 2)}\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(SCHEMA_PATH, renderThemeSchema())
  console.log(`Wrote ${path.relative(repoRoot, SCHEMA_PATH)}`)
}
