import { describe, expect, it } from 'vitest'
import { THEMES } from '../../shared/themes'
import { BUILTINS, BUILTIN_GROUPS, groupStartOffsets } from './themeGroups'
import type { ThemeEntry } from './themeGroups'

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

  it('keeps_builtins_equal_to_light_then_dark_flattened', () => {
    const [light, dark] = BUILTIN_GROUPS
    expect(BUILTINS).toEqual([...(light?.entries ?? []), ...(dark?.entries ?? [])])
  })
})

describe('groupStartOffsets', () => {
  it('is_the_running_total_of_preceding_group_sizes', () => {
    expect(groupStartOffsets([{ entries: [1, 2, 3] }, { entries: [4, 5] }, { entries: [] }])).toEqual([0, 3, 5])
  })

  it('walks_light_dark_then_custom_in_focus_order', () => {
    const customs: ThemeEntry[] = ['a', 'b'].map((id) => ({ key: `custom-${id}`, name: id, swatch: '#000', swatchPrimary: '#fff', builtin: null, customId: id }))
    const all = [...BUILTINS, ...customs]
    const starts = groupStartOffsets(BUILTIN_GROUPS)
    const rendered = [
      ...BUILTIN_GROUPS.flatMap((g, gi) => g.entries.map((e, i) => ({ e, index: (starts[gi] ?? 0) + i }))),
      ...customs.map((e, i) => ({ e, index: BUILTINS.length + i }))
    ]
    expect(rendered.map((r) => r.index)).toEqual(all.map((_, i) => i))
    expect(rendered.every((r) => all[r.index] === r.e)).toBe(true)
    expect(starts[1]).toBe(BUILTIN_GROUPS[0]?.entries.length)
  })
})
