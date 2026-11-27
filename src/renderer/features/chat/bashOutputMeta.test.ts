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
})
