import { describe, expect, it } from 'vitest'
import { THEMES, isLightTheme } from './themes'
import type { ThemeId } from './themes'

const EXISTING_LIGHT: ThemeId[] = ['light', 'light-warm-paper', 'light-high-contrast']
const NEW_LIGHT: ThemeId[] = ['solarized-light', 'github-light', 'catppuccin-latte', 'one-light', 'gruvbox-light', 'rose-pine-dawn']
const EXISTING_DARK: ThemeId[] = ['dark', 'dark-high-contrast', 'obsidian', 'amber-obsidian', 'nordic-frost', 'cyber-amber', 'lagoon', 'amethyst', 'hearth']
const NEW_DARK: ThemeId[] = ['dracula', 'nord', 'tokyo-night', 'catppuccin-mocha', 'gruvbox-dark', 'solarized-dark', 'one-dark']

describe('isLightTheme', () => {
  it.each([...EXISTING_LIGHT, ...NEW_LIGHT])('%s_is_light', (id) => {
    expect(isLightTheme(id)).toBe(true)
  })

  it.each([...EXISTING_DARK, ...NEW_DARK])('%s_is_dark', (id) => {
    expect(isLightTheme(id)).toBe(false)
  })

  it('classifies_every_theme_in_the_registry', () => {
    const classified = [...EXISTING_LIGHT, ...NEW_LIGHT, ...EXISTING_DARK, ...NEW_DARK].sort()
    expect(classified).toEqual(Object.keys(THEMES).sort())
  })
})
