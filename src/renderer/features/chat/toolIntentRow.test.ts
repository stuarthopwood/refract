// FR-140: the row reads the brief label of a call's intent; the full intent is in the row's
// accessible name and its expanded body. The repo has no jsdom, so the collapsed row and the
// expanded body are each rendered to a string.
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TranscriptItem } from '../../../shared/model'

vi.mock('@/state', () => ({ useSettingsStore: (select: (s: { settings: object }) => unknown) => select({ settings: {} }) }))
vi.mock('./ToolRowMenu', () => ({
  ToolRowMenu: ({ children }: { children: ReactNode }) => children,
  ToolRowKebab: () => null
}))

import { ToolCallBody, ToolGroupRow } from './ToolRow'
import { toolRowLabel } from './toolDisplay'
import { fullIntentLine, toolAriaHead } from './toolRowParts'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

const call = (intent: string | undefined): ToolItem => ({
  kind: 'tool',
  id: 't1',
  toolCallId: 'c1',
  tool: 'read',
  target: 'src/main.ts',
  status: 'done',
  args: {},
  intent
})

const render = (item: ToolItem) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ToolGroupRow, { group: { kind: 'tool-group', id: 'g1', tool: item.tool, items: [item] } })))

const renderBody = (item: ToolItem, label: string) =>
  renderToStaticMarkup(createElement(ToolCallBody, { item, label, dialogOpen: false, onDialogOpenChange: () => {} }))

const FULL = 'Reading config: to find the port the server binds'

describe('tool row intent label', () => {
  it('labels the row with the brief label of the intent', () => {
    expect(toolRowLabel('read', 'src/main.ts', FULL, 'done')).toBe('Reading config')
    const html = render(call(FULL))
    expect(html).toMatch(/data-slot="collapsed-line-label"[^>]*>Reading config</)
  })

  it('puts the full intent in the accessible name, never only on hover', () => {
    expect(toolAriaHead('done', 'read', FULL, 'Reading config', undefined, 'src/main.ts')).toBe(`${FULL} src/main.ts`)
    expect(render(call(FULL))).toContain(`aria-label="${FULL} src/main.ts"`)
  })

  it('carries the full intent in the expanded body only when it says more than the label', () => {
    expect(fullIntentLine(FULL, 'Reading config')).toBe(FULL)
    expect(fullIntentLine('Reading config', 'Reading config')).toBeUndefined()
    expect(fullIntentLine(undefined, 'Read')).toBeUndefined()
  })

  it('renders the full intent once in the expanded body when the label differs', () => {
    const html = renderBody(call(FULL), 'Reading config')
    expect(html.split(FULL)).toHaveLength(2)
  })

  it('adds no intent line to the expanded body when the label already is the intent', () => {
    const plain = 'Reading the config file'
    expect(renderBody(call(plain), plain)).not.toContain(plain)
    expect(renderBody(call(undefined), 'Read')).not.toContain('<p')
  })

  it('names a running call by its full intent, with no status prefix', () => {
    expect(toolAriaHead('running', 'read', FULL, 'Reading config', undefined, 'src/main.ts')).toBe(`${FULL} src/main.ts`)
  })

  it('drops the Running prefix for an unmapped tool that shows an intent', () => {
    expect(toolAriaHead('running', 'mcp_fetch', FULL, 'Reading config', undefined, 'src/main.ts')).toBe(`${FULL} src/main.ts`)
  })

  it('keeps the Failed prefix when an errored call shows an intent', () => {
    expect(toolAriaHead('error', 'read', FULL, 'Reading config', undefined, 'src/main.ts')).toBe(`Failed ${FULL} src/main.ts`)
  })

  it('does not repeat the name when the label already is the intent', () => {
    const plain = 'Reading the config file'
    expect(toolAriaHead('running', 'read', plain, plain, undefined, 'src/main.ts')).toBe(`${plain} src/main.ts`)
    expect(toolAriaHead('done', 'read', plain, plain, undefined, 'src/main.ts')).toBe(`${plain} src/main.ts`)
  })

  it('names a call by its label when the intent is empty or whitespace', () => {
    expect(toolAriaHead('running', 'read', '', 'Reading', undefined, 'src/main.ts')).toBe('Reading src/main.ts')
    expect(toolAriaHead('running', 'read', '   \t', 'Reading', undefined, 'src/main.ts')).toBe('Reading src/main.ts')
    expect(toolAriaHead('done', 'read', undefined, 'Read', undefined, 'src/main.ts')).toBe('Read src/main.ts')
  })

  it('shows an intent with no qualifying colon exactly as before', () => {
    expect(toolRowLabel('read', 'src/main.ts', 'Fetching http://x/y', 'done')).toBe('Fetching http://x/y')
    expect(fullIntentLine('Fetching http://x/y', 'Fetching http://x/y')).toBeUndefined()
  })

  it('keeps the verb fallback when the call carries no intent', () => {
    expect(toolRowLabel('read', 'src/main.ts', undefined, 'done')).toBe(toolRowLabel('read', 'src/main.ts', '   ', 'done'))
  })
})
