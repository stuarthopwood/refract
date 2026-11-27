import { describe, expect, it } from 'vitest'
import { THEMES, isLightTheme } from '../src/shared/themes'
import { isLightThemeId } from './theme-groups.mjs'

// Two languages cannot share one list, so this keeps the TS and script copies of "which presets are light" from drifting.
describe('light theme ids', () => {
  it('src/shared/themes.ts and scripts/theme-groups.mjs agree for every preset', () => {
    const fromTs = Object.keys(THEMES).filter((id) => isLightTheme(id)).sort()
    const fromScripts = Object.keys(THEMES).filter((id) => isLightThemeId(id)).sort()
    expect(fromTs.length).toBeGreaterThan(0)
    expect(fromScripts).toEqual(fromTs)
  })
})
