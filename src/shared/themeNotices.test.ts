import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEMES } from './themes'
import type { ThemeId } from './themes'

const notices = readFileSync(new URL('../../src-tauri/resources/THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
const tauriConf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { bundle: { resources: string[] } }

// Themes whose colours come from an open-source palette (#2172); each name is the palette's own, as the notices list it.
const PALETTE_THEMES: ThemeId[] = ['solarized-light', 'solarized-dark', 'github-light', 'catppuccin-latte', 'catppuccin-mocha', 'one-light', 'one-dark', 'gruvbox-light', 'gruvbox-dark', 'rose-pine-dawn', 'dracula', 'nord', 'tokyo-night']

describe('third-party palette notices', () => {
  it.each(PALETTE_THEMES)('%s_has_a_copyright_line', (id) => {
    const name = THEMES[id].name
    const lines = notices.split(/\r?\n/).filter((line) => line.startsWith('- ') && line.includes(name))
    expect(lines.some((line) => /Copyright \(c\)/.test(line)), `${name} copyright line`).toBe(true)
  })

  it('ships_the_notices_file_in_the_bundle', () => {
    expect(tauriConf.bundle.resources).toContain('resources/THIRD_PARTY_NOTICES.md')
  })
})
