import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRustThemeIds, parseTsThemeIds, themeIdParity } from './theme-id-parity.mjs'

const TS = `export type ThemeId =
  | 'dark'
  | 'amber-obsidian'
  | 'dark-high-contrast'

export interface ThemeDefinition {}`

const RUST = `#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeId {
    Dark,
    // Additive (#551).
    DarkHighContrast,
    AmberObsidian, // trailing comment
}`

describe('parseTsThemeIds', () => {
  it('reads every id of a wrapped union', () => {
    expect(parseTsThemeIds(TS)).toEqual(['dark', 'amber-obsidian', 'dark-high-contrast'])
  })

  it('returns nothing when the union is absent', () => {
    expect(parseTsThemeIds('export const x = 1')).toEqual([])
  })

  it('rejects a union split by a blank line instead of truncating it', () => {
    const split = TS.replace("  | 'amber-obsidian'", "\n  | 'amber-obsidian'")
    expect(() => parseTsThemeIds(split)).toThrow(/blank line/)
  })
})

describe('parseRustThemeIds', () => {
  it('kebab-cases variants and skips comments', () => {
    expect(parseRustThemeIds(RUST)).toEqual(['dark', 'dark-high-contrast', 'amber-obsidian'])
  })

  it('returns nothing when the enum is absent', () => {
    expect(parseRustThemeIds('pub enum Other { A }')).toEqual([])
  })

  it('rejects a per-variant serde rename, which breaks the kebab-case derivation', () => {
    const renamed = RUST.replace('    AmberObsidian,', '    #[serde(rename = "amber")]\n    AmberObsidian,')
    expect(() => parseRustThemeIds(renamed)).toThrow(/serde\(rename/)
  })

  it('rejects an enum without rename_all = "kebab-case"', () => {
    expect(() => parseRustThemeIds(RUST.replace('kebab-case', 'snake_case'))).toThrow(/kebab-case/)
    expect(() => parseRustThemeIds(RUST.replace('#[serde(rename_all = "kebab-case")]\n', ''))).toThrow(/kebab-case/)
  })
})

describe('themeIdParity', () => {
  it('passes when both sides hold the same ids in any order', () => {
    expect(themeIdParity(parseTsThemeIds(TS), parseRustThemeIds(RUST))).toEqual({ onlyInTs: [], onlyInRust: [] })
  })

  it('flags an id that only the TS union has (the #2171 bug)', () => {
    const rust = parseRustThemeIds(RUST.replace('AmberObsidian,', ''))
    expect(themeIdParity(parseTsThemeIds(TS), rust).onlyInTs).toEqual(['amber-obsidian'])
  })

  it('flags an id that only the Rust enum has', () => {
    const ts = parseTsThemeIds(TS.replace("  | 'amber-obsidian'\n", ''))
    expect(themeIdParity(ts, parseRustThemeIds(RUST)).onlyInRust).toEqual(['amber-obsidian'])
  })
})

describe('the real files', () => {
  it('src/shared/themes.ts and the Rust ThemeId enum agree', () => {
    const ts = parseTsThemeIds(readFileSync('src/shared/themes.ts', 'utf-8'))
    const rust = parseRustThemeIds(readFileSync('src-tauri/src/store/theme_id.rs', 'utf-8'))
    expect(ts.length).toBeGreaterThan(0)
    expect(themeIdParity(ts, rust)).toEqual({ onlyInTs: [], onlyInRust: [] })
  })
})
