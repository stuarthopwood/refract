// Compares the `ThemeId` ids in src/shared/themes.ts with the Rust `ThemeId` enum, both directions (#2171).
// `theme.set` parses the id into the Rust enum, so an id on the TS side only is rejected at runtime.

const UNION_RE = /export type ThemeId\s*=\s*([\s\S]+?)(?:\r?\n\s*\r?\n|\r?\n\s*\/\/|\r?\nexport|;)/
const ENUM_RE = /pub enum ThemeId\s*\{([\s\S]*?)\n\}/

/** Ids of the TS `ThemeId` union, in declaration order; empty when the union is not found. */
export function parseTsThemeIds(src) {
  const match = src.match(UNION_RE)
  return match ? [...match[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]) : []
}

// serde `rename_all = "kebab-case"`: split before each capital, lowercase, join with `-`.
const toKebab = (variant) => variant.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase()

/** Serialised ids of the Rust `ThemeId` enum, in declaration order; empty when the enum is not found. */
export function parseRustThemeIds(src) {
  const body = src.match(ENUM_RE)?.[1]
  if (body === undefined) return []
  const variants = []
  for (const line of body.split(/\r?\n/)) {
    const variant = line.replace(/\/\/.*$/, '').trim().match(/^([A-Z][A-Za-z0-9]*)\s*,?$/)
    if (variant) variants.push(toKebab(variant[1]))
  }
  return variants
}

/** `{ onlyInTs, onlyInRust }`; both empty means the two lists agree. */
export function themeIdParity(tsIds, rustIds) {
  const rust = new Set(rustIds)
  const ts = new Set(tsIds)
  return { onlyInTs: tsIds.filter((id) => !rust.has(id)), onlyInRust: rustIds.filter((id) => !ts.has(id)) }
}
