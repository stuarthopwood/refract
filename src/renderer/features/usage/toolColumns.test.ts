import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UsageBreakdownRow } from '../../../shared/ipc-usage'
import { TOOL_COLUMNS } from './toolColumns'

const row = (label: string, costShare?: number): UsageBreakdownRow => ({ label, calls: 1, tokens: 0, usd: 0, credits: 0, costShare })
const shareColumn = TOOL_COLUMNS.find((c) => c.key === 'share')!
const sortKey = (r: UsageBreakdownRow) => shareColumn.sortValue!(r) as number

describe('tool table Cost share column', () => {
  it('ranks an unpriced row below a priced 0%', () => {
    expect(sortKey(row('edit'))).toBeLessThan(sortKey(row('read', 0)))
  })

  it('sorts unpriced rows last descending and first ascending', () => {
    const rows = [row('a', 0.5), row('b'), row('c', 0)]
    const asc = [...rows].sort((x, y) => sortKey(x) - sortKey(y))
    expect(asc.map((r) => r.label)).toEqual(['b', 'c', 'a'])
    const desc = [...rows].sort((x, y) => sortKey(y) - sortKey(x))
    expect(desc.map((r) => r.label)).toEqual(['a', 'c', 'b'])
  })

  it('renders a percentage when priced and a labelled dash when not', () => {
    expect(shareColumn.render(row('bash', 0.75))).toBe('75%')
    const unpriced = renderToStaticMarkup(shareColumn.render(row('edit')) as ReactElement)
    expect(unpriced).toContain('No priced calls')
  })
})
