// Compares the `ThemeId` ids in src/shared/themes.ts with the Rust `ThemeId` enum, both directions (#2171).
// `theme.set` parses the id into the Rust enum, so an id on the TS side only is rejected at runtime.

const UNION_RE = /export type ThemeId\s*=\s*([\s\S]+?)(?:\r?\n\s*\r?\n|\r?\n\s*\/\/|\r?\nexport|;)/
const ENUM_RE = /((?:[ \t]*#\[[^\r\n]*\]\r?\n)*)pub enum ThemeId\s*\{([\s\S]*?)\n\}/
const KEBAB_RENAME_ALL_RE = /#\[serde\([^\]]*\brename_all\s*=\s*"kebab-case"/

/** Ids of the TS `ThemeId` union, declaration order; throws when a blank line would silently truncate it. */
export function parseTsThemeIds(src) {
  const match = src.match(UNION_RE)
  if (!match) return []
  const rest = src.slice(match.index + match[0].length)
  if (/^\s*\|/.test(rest)) throw new Error('the ThemeId union in src/shared/themes.ts continues past a blank line; the parity check would drop the later ids')
  return [...match[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map((m) => m[1])
}

// serde `rename_all = "kebab-case"`: split before each capital, lowercase, join with `-`.
const toKebab = (variant) => variant.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase()

/** Serialised Rust `ThemeId` ids, declaration order; throws when the kebab-case mapping does not hold. */
export function parseRustThemeIds(src) {
  const match = src.match(ENUM_RE)
  if (!match) return []
  const [, attributes, body] = match
  if (!KEBAB_RENAME_ALL_RE.test(attributes)) throw new Error('the Rust ThemeId enum is not annotated #[serde(rename_all = "kebab-case")]; its serialised ids cannot be derived from the variant names')
  if (body.includes('#[serde(rename')) throw new Error('the Rust ThemeId enum has a #[serde(rename ...)] variant attribute; its serialised id no longer follows the variant name')
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
