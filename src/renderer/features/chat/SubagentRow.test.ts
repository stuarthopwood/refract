// The repo has no jsdom: components are rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The real store needs `window`: mock it for ShimmerText (via CollapsedLine) and Markdown's code blocks.
vi.mock('@/state', () => ({ useSettingsStore: (select: (s: { settings: object }) => unknown) => select({ settings: {} }) }))
vi.mock('./Markdown', () => ({ CodeBlock: () => null, inferOutputBlock: (text: string) => ({ code: text, lang: 'text' }) }))

import type { TranscriptItem } from '../../../shared/model'
import type { SubAgentItem } from '../subagents/viewModel'
import { SubagentRow } from './SubagentRow'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

const ITEM: SubagentItem = { kind: 'subagent', id: 'i1', toolCallId: 't1', specIndex: 0, name: 'GateA11y', task: 'Check it', status: 'done', messageId: 'm1' }

function agent(overrides: Partial<SubAgentItem> = {}): SubAgentItem {
  return { id: 'GateA11y', key: 't1:0', toolCallId: 't1', specIndex: 0, name: 'GateA11y', status: 'finished', ...overrides }
}

const render = (a: SubAgentItem, variant?: 'default' | 'card') =>
  renderToStaticMarkup(createElement(SubagentRow, { item: ITEM, agent: a, showGoal: false, variant }))

const manySteps = [
  ...Array.from({ length: 4 }, (_, i) => ({ label: `done ${i}`, status: 'done' as const })),
  { label: 'running now', status: 'running' as const },
  ...Array.from({ length: 5 }, (_, i) => ({ label: `todo ${i}`, status: 'pending' as const }))
]

describe('SubagentRow default variant (#1928, FR-148 a)', () => {
  it('stays a collapsed line with the name, the one-line summary and the duration, and none of the card parts', () => {
    const rich = agent({ role: 'Accessibility Gate', whatItDid: 'Flagged one defect', duration: '2m', triggeredBy: 'Other', filesTouched: ['a.ts'], liveDetail: 'busy', subSteps: manySteps })
    const html = render(rich)
    expect(html).toContain('GateA11y')
    expect(html).toContain('Flagged one defect')
    expect(html).toContain('2m')
    for (const card of ['Accessibility Gate', 'fixes issue from', 'Files touched', 'busy', 'Sub-steps']) expect(html).not.toContain(card)
  })

  it('renders the same markup when the variant is given explicitly as default', () => {
    const a = agent({ whatItDid: 'Done', duration: '1s' })
    expect(render(a, 'default')).toBe(render(a))
  })
})

describe('SubagentRow card variant (#1928, FR-148)', () => {
  it('shows name, role, the two-line-clamped outcome with its full text in the title, and the duration', () => {
    const html = render(agent({ role: 'Accessibility Gate', whatItDid: 'Flagged 1 minor badge contrast issue', duration: '3m 12s' }), 'card')
    expect(html).toContain('GateA11y')
    expect(html).toContain('Accessibility Gate')
    expect(html).toMatch(/<p title="Flagged 1 minor badge contrast issue" class="[^"]*line-clamp-2/)
    expect(html).toContain('3m 12s')
  })

  it('shows the causal badge and the Files touched group on one row', () => {
    const html = render(agent({ triggeredBy: 'GateA11y757m', filesTouched: ['src/a.ts'] }), 'card')
    expect(html).toContain('fixes issue from GateA11y757m')
    expect(html).toContain('aria-label="Files touched"')
    expect(html.indexOf('fixes issue from')).toBeLessThan(html.indexOf('Files touched'))
    expect(html).toMatch(/fixes issue from GateA11y757m<\/span><\/span><div role="group"/)
  })

  it('shows four file chips and a "+N" button with aria-expanded', () => {
    const html = render(agent({ filesTouched: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }), 'card')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('+2')
    expect(html).not.toContain('>e.ts<')
  })

  it('shows the heartbeat and a capped sub-step list while running, with folds', () => {
    const html = render(agent({ status: 'running', liveDetail: 'On scenario (f) [6/6]', subSteps: manySteps }), 'card')
    expect(html).toContain('On scenario (f) [6/6]')
    expect(html).toContain('running now')
    expect(html).toContain('>1 done<')
    expect(html).toContain('>+3 queued<')
    expect(html).toContain('border-state-working/50')
    expect(html).not.toContain('aria-live')
  })

  it('hides the heartbeat and sub-steps once the agent is no longer running', () => {
    const html = render(agent({ status: 'finished', liveDetail: 'stale', subSteps: manySteps }), 'card')
    expect(html).not.toContain('stale')
    expect(html).not.toContain('Sub-steps')
  })

  it('leaves no empty row or divider for an agent with none of the optional fields', () => {
    const html = render(agent({ status: 'running' }), 'card')
    expect(html).not.toMatch(/<p[ >]/)
    expect(html).not.toContain('Files touched')
    expect(html).not.toContain('border-divider')
    expect(html).not.toContain('flex min-w-0 flex-wrap items-center gap-1"')
  })

  it('omits an empty file list and a blank trigger rather than rendering an empty row', () => {
    const html = render(agent({ filesTouched: [], triggeredBy: ' ' }), 'card')
    expect(html).not.toContain('Files touched')
    expect(html).not.toContain('fixes issue from')
  })
})
