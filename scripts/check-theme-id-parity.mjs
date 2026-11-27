#!/usr/bin/env node
// `pnpm check:theme-ids`: fails when a theme id exists in src/shared/themes.ts or in the Rust `ThemeId` enum but not both (#2171).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRustThemeIds, parseTsThemeIds, themeIdParity } from './theme-id-parity.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsPath = 'src/shared/themes.ts'
const rustPath = 'src-tauri/src/store/theme_id.rs'
const tsIds = parseTsThemeIds(readFileSync(path.join(repoRoot, tsPath), 'utf-8'))
const rustIds = parseRustThemeIds(readFileSync(path.join(repoRoot, rustPath), 'utf-8'))

// An unparsable file would read as "no ids" and pass vacuously, so fail loudly instead.
if (tsIds.length === 0 || rustIds.length === 0) {
  console.error(`could not parse theme ids (${tsPath}: ${tsIds.length}, ${rustPath}: ${rustIds.length})`)
  process.exit(2)
}

const { onlyInTs, onlyInRust } = themeIdParity(tsIds, rustIds)
for (const id of onlyInTs) console.error(`'${id}' is in ${tsPath} but missing from the Rust ThemeId enum; theme.set would reject it`)
for (const id of onlyInRust) console.error(`'${id}' is in the Rust ThemeId enum but missing from ${tsPath}`)
if (onlyInTs.length + onlyInRust.length > 0) process.exit(1)
console.log(`theme ids in parity: ${tsIds.length} in ${tsPath} and the Rust enum`)
