// The repo has no jsdom: rows are rendered to a static string under a settings-store mock, one case per Tool targets mode (#1758).
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TranscriptItem } from '../../../shared/model'

const store = vi.hoisted(() => ({ settings: {} as object }))
vi.mock('@/state', () => ({ useSettingsStore: (select: (s: { settings: object }) => unknown) => select({ settings: store.settings }) }))
vi.mock('./ToolRowMenu', () => ({
  ToolRowMenu: ({ children }: { children: ReactNode }) => children,
  ToolRowKebab: () => null
}))

import { ToolCallRow, ToolGroupRow } from './ToolRow'
import { useToolTargets } from './toolRowParts'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

const TARGET = 'src/main.ts'
const item: ToolItem = { kind: 'tool', id: 't1', toolCallId: 'c1', tool: 'read', target: TARGET, status: 'done', args: {} }

const withSettings = (transcriptDisplay: object): void => {
  store.settings = { transcriptDisplay }
}

const callRow = (): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ToolCallRow, { item, dialogOpen: false, onDialogOpenChange: () => {} })))
const groupRow = (): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ToolGroupRow, { group: { kind: 'tool-group', id: 'g1', tool: 'read', items: [item] } })))

const ariaLabel = (html: string): string => /aria-label="([^"]*)"/.exec(html)?.[1] ?? ''
const tooltipText = (html: string): string | undefined => /<span id="[^"]*" class="sr-only">([^<]*)<\/span>/.exec(html)?.[1]
const hasChip = (html: string): boolean => html.includes('data-slot="tool-target"')

const rows = [
  ['ToolCallRow', callRow],
  ['ToolGroupRow', groupRow]
] as const

describe.each(rows)('%s under each Tool targets mode', (_name, render) => {
  describe('given Hide', () => {
    it('shows no chip, tooltips only the raw id and keeps the target in the accessible name', () => {
      withSettings({ toolTargets: 'hide' })
      const html = render()
      expect(hasChip(html)).toBe(false)
      expect(tooltipText(html)).toBe('read')
      expect(ariaLabel(html)).toContain(TARGET)
    })
  })

  describe('given Hover', () => {
    it('shows no chip, tooltips the raw id with the target and keeps the target in the accessible name', () => {
      withSettings({ toolTargets: 'hover' })
      const html = render()
      expect(hasChip(html)).toBe(false)
      expect(tooltipText(html)).toBe(`read: ${TARGET}`)
      expect(ariaLabel(html)).toContain(TARGET)
    })

    it('skips the description when the name already says the whole tooltip (raw id shown)', () => {
      withSettings({ toolTargets: 'hover', toolNames: true })
      const html = render()
      expect(ariaLabel(html)).toContain(TARGET)
      expect(ariaLabel(html)).toContain('read')
      expect(html).not.toContain('aria-describedby')
      expect(tooltipText(html)).toBeUndefined()
    })
  })

  describe('given Show', () => {
    it('shows the target chip, tooltips only the raw id and keeps the target in the accessible name', () => {
      withSettings({ toolTargets: 'show' })
      const html = render()
      expect(hasChip(html)).toBe(true)
      expect(html).toContain(`>${TARGET}</code>`)
      expect(tooltipText(html)).toBe('read')
      expect(ariaLabel(html)).toContain(TARGET)
    })
  })
})

describe('useToolTargets', () => {
  const Probe = () => createElement('span', null, useToolTargets())
  const read = (transcriptDisplay: object | undefined): string => {
    store.settings = { transcriptDisplay }
    return renderToStaticMarkup(createElement(Probe))
  }

  it('falls back to Hover when the setting is missing', () => {
    expect(read(undefined)).toBe('<span>hover</span>')
    expect(read({})).toBe('<span>hover</span>')
  })

  it('falls back to Hover when the value is unknown', () => {
    expect(read({ toolTargets: 'everywhere' })).toBe('<span>hover</span>')
    expect(read({ toolTargets: 3 })).toBe('<span>hover</span>')
  })

  it('returns each valid mode as stored', () => {
    expect(read({ toolTargets: 'hide' })).toBe('<span>hide</span>')
    expect(read({ toolTargets: 'show' })).toBe('<span>show</span>')
  })
})
