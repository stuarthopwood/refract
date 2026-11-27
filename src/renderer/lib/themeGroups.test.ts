import { describe, expect, it } from 'vitest'
import { THEMES, isLightTheme } from '../../shared/themes'
import { BUILTINS, BUILTIN_GROUPS, groupStartOffsets, rowIndex } from './themeGroups'
import type { ThemeEntry } from './themeGroups'

const groupEntries = (label: string): ThemeEntry[] => BUILTIN_GROUPS.find((g) => g.label === label)?.entries ?? []

describe('BUILTIN_GROUPS', () => {
  it('puts_each_theme_id_in_exactly_one_group', () => {
    const ids = BUILTIN_GROUPS.flatMap((g) => g.entries.map((e) => e.key))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers_every_themes_key', () => {
    const ids = BUILTIN_GROUPS.flatMap((g) => g.entries.map((e) => e.key))
    expect(ids.sort()).toEqual(Object.keys(THEMES).sort())
  })

  it('lists_light_then_dark', () => {
    expect(BUILTIN_GROUPS.map((g) => g.label)).toEqual(['Light', 'Dark'])
  })

  it('fills_the_light_group_with_only_light_themes', () => {
    const light = groupEntries('Light')
    expect(light.length).toBeGreaterThan(0)
    expect(light.every((e) => e.builtin !== null && isLightTheme(e.builtin))).toBe(true)
  })

  it('fills_the_dark_group_with_only_dark_themes', () => {
    const dark = groupEntries('Dark')
    expect(dark.length).toBeGreaterThan(0)
    expect(dark.every((e) => e.builtin !== null && !isLightTheme(e.builtin))).toBe(true)
  })

  it('keeps_each_group_in_themes_key_order', () => {
    const themeOrder = Object.values(THEMES)
    expect(groupEntries('Light').map((e) => e.key)).toEqual(themeOrder.filter((t) => isLightTheme(t.id)).map((t) => t.id))
    expect(groupEntries('Dark').map((e) => e.key)).toEqual(themeOrder.filter((t) => !isLightTheme(t.id)).map((t) => t.id))
  })

  it('starts_builtins_with_the_first_light_theme_then_the_first_dark_theme', () => {
    expect(BUILTINS[0]?.key).toBe('light')
    expect(BUILTINS[groupEntries('Light').length]?.key).toBe('dark')
    expect(BUILTINS).toHaveLength(Object.keys(THEMES).length)
  })
})

describe('groupStartOffsets', () => {
  it('is_the_running_total_of_preceding_group_sizes', () => {
    expect(groupStartOffsets([{ entries: [1, 2, 3] }, { entries: [4, 5] }, { entries: [] }])).toEqual([0, 3, 5])
  })
})

describe('rowIndex', () => {
  it('walks_light_dark_then_custom_in_focus_order', () => {
    const customs: ThemeEntry[] = ['a', 'b'].map((id) => ({ key: `custom-${id}`, name: id, swatch: '#000', swatchPrimary: '#fff', builtin: null, customId: id }))
    const all = [...BUILTINS, ...customs]
    const starts = groupStartOffsets(BUILTIN_GROUPS)
    const rendered = [
      ...BUILTIN_GROUPS.flatMap((g, gi) => g.entries.map((e, i) => ({ e, index: rowIndex(gi, i, starts, BUILTINS.length) }))),
      ...customs.map((e, i) => ({ e, index: rowIndex(null, i, starts, BUILTINS.length) }))
    ]
    expect(rendered.map((r) => r.index)).toEqual(all.map((_, i) => i))
    expect(rendered.every((r) => all[r.index] === r.e)).toBe(true)
  })

  it('offsets_the_second_group_by_the_first_groups_size', () => {
    expect(rowIndex(1, 0, [0, 3], 5)).toBe(3)
  })

  it('places_custom_rows_after_every_builtin', () => {
    expect(rowIndex(null, 1, [0, 3], 5)).toBe(6)
  })
})
