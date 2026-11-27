import { describe, expect, it } from 'vitest'
import { ERROR_CATEGORY_COLUMNS, errorCategoryDisplayRows } from './errorCategories'

describe('errorCategoryDisplayRows', () => {
  it('labels each category and gives its share of the failed calls', () => {
    const rows = errorCategoryDisplayRows([
      { category: 'policy', count: 3 },
      { category: 'edit_rejected', count: 1 }
    ])

    expect(rows).toEqual([
      { category: 'policy', label: 'Blocked by policy', count: 3, share: 0.75 },
      { category: 'edit_rejected', label: 'Edit rejected', count: 1, share: 0.25 }
    ])
  })

  it('returns no rows when the window has no failed call, so the table stays absent', () => {
    expect(errorCategoryDisplayRows([])).toEqual([])
    expect(errorCategoryDisplayRows([{ category: 'other', count: 0 }])).toEqual([])
  })

  it('names the unknown bucket so errors recorded before categories are not hidden', () => {
    const rows = errorCategoryDisplayRows([{ category: 'unknown', count: 2 }])

    expect(rows[0]?.label).toMatch(/before categories/)
    expect(rows[0]?.share).toBe(1)
  })

  it('sorts by count through the share column', () => {
    const rows = errorCategoryDisplayRows([
      { category: 'timeout', count: 1 },
      { category: 'aborted', count: 4 }
    ])
    const share = ERROR_CATEGORY_COLUMNS.find((c) => c.key === 'share')!
    const values = rows.map((r) => share.sortValue!(r) as number)

    expect(values[0]).toBeLessThan(values[1]!)
  })
})
