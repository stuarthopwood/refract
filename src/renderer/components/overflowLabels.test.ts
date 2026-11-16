// Each test names the mutation of `overflowLabels.ts` that makes it fail.
import { describe, expect, it } from 'vitest'
import { overflowChipName, splitOverflowLabels } from './overflowLabels'

const abc = ['a', 'b', 'c', 'd'].map((name) => ({ name }))

describe('splitOverflowLabels', () => {
  it('shows the first `max` labels in order and hides the rest in order', () => {
    // Mutations: slice from the end, swap shown and hidden, or off-by-one on the cap.
    const { shown, hidden } = splitOverflowLabels(abc, 2)
    expect(shown.map((l) => l.name)).toEqual(['a', 'b'])
    expect(hidden.map((l) => l.name)).toEqual(['c', 'd'])
  })

  it('hides nothing when the list fits, including exactly at the cap', () => {
    // Mutation: use `<` instead of the slice boundary so a full row still gets a chip.
    expect(splitOverflowLabels(abc.slice(0, 2), 2).hidden).toEqual([])
    expect(splitOverflowLabels(abc.slice(0, 1), 2)).toEqual({ shown: abc.slice(0, 1), hidden: [] })
    expect(splitOverflowLabels([], 2)).toEqual({ shown: [], hidden: [] })
  })

  it('hides exactly one label when the list is one over the cap', () => {
    // Mutation: cap + 1 or cap - 1 in the shown slice.
    const { shown, hidden } = splitOverflowLabels(abc.slice(0, 3), 2)
    expect(shown).toHaveLength(2)
    expect(hidden.map((l) => l.name)).toEqual(['c'])
  })

  it('treats a negative cap as zero instead of slicing from the end', () => {
    // Mutation: remove the `Math.max(0, max)` guard (`slice(0, -1)` would show three of four).
    const { shown, hidden } = splitOverflowLabels(abc, -1)
    expect(shown).toEqual([])
    expect(hidden).toEqual(abc)
  })

  it('does not mutate or alias the input list', () => {
    // Mutation: return the input array itself for `shown` or `hidden`.
    const input = [...abc]
    const { shown, hidden } = splitOverflowLabels(input, 10)
    expect(input).toEqual(abc)
    expect(shown).not.toBe(input)
    expect(hidden).not.toBe(input)
  })
})

describe('overflowChipName', () => {
  it('starts with the visible +N and lists the hidden names in order', () => {
    // Mutations: drop the "+", drop the names, or reorder them (WCAG 2.5.3 label-in-name).
    expect(overflowChipName(abc.slice(0, 3))).toBe('+3 more labels: a, b, c')
  })

  it('uses the singular noun for one hidden label', () => {
    // Mutation: always plural.
    expect(overflowChipName([{ name: 'docs' }])).toBe('+1 more label: docs')
  })

  it('keeps label text verbatim, as untrusted plain text', () => {
    // Mutation: trim, lower-case or escape the names.
    expect(overflowChipName([{ name: '<b>x</b>' }, { name: 'Help Wanted' }])).toBe('+2 more labels: <b>x</b>, Help Wanted')
  })
})
