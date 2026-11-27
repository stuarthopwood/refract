// The repo has no jsdom, so the badges and notes are rendered to a string and read as markup.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BashOutputBadges, BashOutputNotes } from './BashOutputBadges'
import { bashOutputAriaText, bashOutputFacts, minimizedTooltip, truncatedTooltip } from './bashOutputMeta'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

function bash(details: unknown, tool = 'bash'): ToolItem {
  return { kind: 'tool', id: 'i', toolCallId: 'c', tool, target: 'git diff', status: 'done', args: {}, details }
}

const MIDDLE_CUT = { meta: { truncation: { direction: 'middle', totalLines: 1393, totalBytes: 190_000, outputLines: 153, outputBytes: 40_780, elidedLines: 1240, elidedBytes: 90_214 } } }
const MINIMIZED = { meta: { minimized: { filter: 'git', inputBytes: 123_290, outputBytes: 3_277 } } }

describe('bashOutputFacts', () => {
  it('reads an elided-output cut from details.meta.truncation', () => {
    expect(bashOutputFacts(bash(MIDDLE_CUT)).truncated).toEqual({ elidedLines: 1240, elidedBytes: 90_214, columnLines: undefined, columnMax: undefined })
  })

  it('derives the amount from the totals when a head or tail cut names no elided counts', () => {
    const facts = bashOutputFacts(bash({ meta: { truncation: { totalLines: 500, outputLines: 200, totalBytes: 60_000, outputBytes: 20_000 } } }))
    expect(facts.truncated).toMatchObject({ elidedLines: 300, elidedBytes: 40_000 })
  })

  it('reads the flat RPC spelling and the per-line column cap', () => {
    const facts = bashOutputFacts(bash({ elidedBytes: 2048, columnTruncatedLines: 3, columnMax: 768 }))
    expect(facts.truncated).toEqual({ elidedLines: undefined, elidedBytes: 2048, columnLines: 3, columnMax: 768 })
  })

  it('reads the minimizer filter and sizes', () => {
    expect(bashOutputFacts(bash(MINIMIZED)).minimized).toEqual({ filter: 'git', inputBytes: 123_290, outputBytes: 3_277 })
  })

  it('reports nothing for a result with neither fact, for other tools and for missing details', () => {
    expect(bashOutputFacts(bash({ exitCode: 0, meta: {} }))).toEqual({})
    expect(bashOutputFacts(bash(undefined))).toEqual({})
    expect(bashOutputFacts(bash(MIDDLE_CUT, 'read'))).toEqual({})
  })

  it('ignores a minimized record with no filter name', () => {
    expect(bashOutputFacts(bash({ meta: { minimized: { inputBytes: 10 } } }))).toEqual({})
  })

  it('counts the column-cut lines from the meta range when the flat count is absent', () => {
    const facts = bashOutputFacts(bash({ meta: { limits: { columnTruncated: { maxColumn: 768, lines: { first: 4, last: 9 } } } } }))
    expect(facts.truncated).toMatchObject({ columnLines: 6, columnMax: 768 })
  })

  it('prefers the flat column-cut count over the meta range', () => {
    const facts = bashOutputFacts(bash({ columnTruncatedLines: 2, meta: { limits: { columnTruncated: { maxColumn: 768, lines: { first: 4, last: 9 } } } } }))
    expect(facts.truncated).toMatchObject({ columnLines: 2 })
  })

  it('reports a truncation that only dropped bytes', () => {
    expect(bashOutputFacts(bash({ meta: { truncation: { totalBytes: 5000, outputBytes: 1000 } } })).truncated).toEqual({
      elidedLines: undefined,
      elidedBytes: 4000,
      columnLines: undefined,
      columnMax: undefined
    })
  })
})

describe('tooltips', () => {
  it('names the lines and bytes not shown', () => {
    expect(truncatedTooltip({ elidedLines: 1240, elidedBytes: 90_214 })).toBe('Output truncated: 1,240 lines (88.1 KB) not shown')
  })

  it('adds the column cap', () => {
    expect(truncatedTooltip({ columnLines: 3, columnMax: 768 })).toBe('Output truncated: 3 lines cut at 768 B')
  })

  it('names the filter and sizes', () => {
    expect(minimizedTooltip({ filter: 'git', inputBytes: 123_290, outputBytes: 3_277 })).toBe('Minimized by git: 120.4 KB to 3.2 KB')
  })

  it('drops the sizes when OMP gave only one', () => {
    expect(minimizedTooltip({ filter: 'git', inputBytes: 10 })).toBe('Minimized by git')
  })

  it('says "1 line", not "1 lines"', () => {
    expect(truncatedTooltip({ elidedLines: 1, elidedBytes: 100 })).toBe('Output truncated: 1 line (100 B) not shown')
    expect(truncatedTooltip({ columnLines: 1, columnMax: 768 })).toBe('Output truncated: 1 line cut at 768 B')
  })

  it('names only the bytes when OMP gave no line count', () => {
    expect(truncatedTooltip({ elidedBytes: 2048 })).toBe('Output truncated: 2.0 KB not shown')
  })
})

const render = (node: React.ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, node))

describe('BashOutputBadges', () => {
  it('shows both badges, hidden from assistive tech because the row name carries the sentences', () => {
    const facts = bashOutputFacts(bash({ meta: { ...MIDDLE_CUT.meta, ...MINIMIZED.meta } }))
    const html = render(createElement(BashOutputBadges, { facts }))
    expect(html).toContain('Truncated')
    expect(html).toContain('Minimized')
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2)
    expect(bashOutputAriaText(facts)).toBe('Output truncated: 1,240 lines (88.1 KB) not shown, Minimized by git: 120.4 KB to 3.2 KB')
  })

  it('renders nothing when OMP reported neither fact', () => {
    expect(render(createElement(BashOutputBadges, { facts: {} }))).toBe('')
    expect(bashOutputAriaText({})).toBeUndefined()
  })

  it('writes the same facts as visible sentences in the dialog notes', () => {
    const html = render(createElement(BashOutputNotes, { facts: bashOutputFacts(bash(MIDDLE_CUT)) }))
    expect(html).toContain('Output truncated: 1,240 lines (88.1 KB) not shown')
  })

  it('writes the minimized fact as a visible sentence in the dialog notes', () => {
    const html = render(createElement(BashOutputNotes, { facts: bashOutputFacts(bash(MINIMIZED)) }))
    expect(html).toContain('Minimized by git: 120.4 KB to 3.2 KB')
    expect(html).not.toContain('Output truncated')
  })

  it('shows only the Truncated badge when nothing was minimized', () => {
    const html = render(createElement(BashOutputBadges, { facts: bashOutputFacts(bash(MIDDLE_CUT)) }))
    expect(html).toContain('Truncated')
    expect(html).not.toContain('Minimized')
  })

  it('shows only the Minimized badge when nothing was truncated', () => {
    const html = render(createElement(BashOutputBadges, { facts: bashOutputFacts(bash(MINIMIZED)) }))
    expect(html).toContain('Minimized')
    expect(html).not.toContain('Truncated')
  })
})
