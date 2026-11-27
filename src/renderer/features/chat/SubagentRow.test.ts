// The repo has no jsdom: components are rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The real store needs `window`: mock it for ShimmerText (via CollapsedLine) and Markdown's code blocks.
const openHostedPanel = vi.hoisted(() => vi.fn())
const readout = vi.hoisted(() => ({ subagents: [] as { id: string; toolCallId: string; specIndex: number }[] }))
vi.mock('@/state', () => ({
  EMPTY_READOUT_ENTRY: { subagents: [] },
  useReadoutStore: (select: (s: { bySession: Record<string, { subagents: unknown[] }> }) => unknown) => select({ bySession: { s1: { subagents: readout.subagents } } }),
  useSettingsStore: (select: (s: { settings: object }) => unknown) => select({ settings: {} })
}))
vi.mock('../right-pane/hosted-panel-actions', () => ({ openHostedPanel }))
// `Markdown` echoes its props so the card tests can assert it is the renderer used, with the options the card needs.
vi.mock('./Markdown', async () => {
  // vi.mock is hoisted above the file's imports, so the factory cannot see `createElement`; a dynamic import is the vitest-sanctioned way.
  const { createElement: h } = await import('react')
  return {
    CodeBlock: ({ embedded }: { embedded?: boolean }) => h('i', { 'data-code': embedded ? 'embedded' : 'bordered' }),
    inferOutputBlock: (text: string) => ({ code: text, lang: text.startsWith('{') ? 'json' : null }),
    Markdown: ({ text, inert, embedded, className }: { text: string; inert?: boolean; embedded?: boolean; className?: string }) =>
      h('span', { 'data-md': '', 'data-inert': String(inert), 'data-embedded': String(embedded), className }, text)
  }
})

import type { TranscriptItem } from '../../../shared/model'
import type { SubAgentItem } from '../subagents/viewModel'
import { SubagentCardBody, SubagentCardButton, openSubagentInPanel, subagentCardButtonName } from './SubagentRow'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

const ITEM: SubagentItem = { kind: 'subagent', id: 'i1', toolCallId: 't1', specIndex: 0, name: 'GateA11y', task: 'Check it', status: 'done', messageId: 'm1' }

function agent(overrides: Partial<SubAgentItem> = {}): SubAgentItem {
  return { id: 'GateA11y', key: 't1:0', toolCallId: 't1', specIndex: 0, name: 'GateA11y', status: 'finished', ...overrides }
}

const render = (a: SubAgentItem, flat = false) => renderToStaticMarkup(createElement(SubagentCardBody, { agent: a, flat }))

const manySteps = [
  ...Array.from({ length: 4 }, (_, i) => ({ label: `done ${i}`, status: 'done' as const })),
  { label: 'running now', status: 'running' as const },
  ...Array.from({ length: 5 }, (_, i) => ({ label: `todo ${i}`, status: 'pending' as const }))
]

describe('SubagentCardBody (#1928, FR-148)', () => {
  it('shows name, role, the two-line-clamped outcome with its full text in the title, and the duration', () => {
    const html = render(agent({ role: 'Accessibility Gate', whatItDid: 'Flagged 1 minor badge contrast issue', duration: '3m 12s' }))
    expect(html).toContain('GateA11y')
    expect(html).toContain('Accessibility Gate')
    expect(html).toMatch(/<div title="Flagged 1 minor badge contrast issue" class="text-sm[^"]*">/)
    expect(html).toContain('[&amp;_p]:line-clamp-2')
    expect(html).toContain('3m 12s')
  })

  it('shows the causal badge and the Files touched group on one row', () => {
    const html = render(agent({ triggeredBy: 'GateA11y757m', filesTouched: ['src/a.ts'] }))
    expect(html).toContain('fixes issue from GateA11y757m')
    expect(html).toContain('aria-label="Files touched"')
    expect(html.indexOf('fixes issue from')).toBeLessThan(html.indexOf('Files touched'))
    expect(html).toMatch(/fixes issue from GateA11y757m<\/span><\/span><div role="group"/)
  })

  it('shows four file chips and a "+N" button with aria-expanded', () => {
    const html = render(agent({ filesTouched: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('+2')
    expect(html).not.toContain('>e.ts<')
  })

  it('shows the heartbeat and a capped sub-step list while running, with folds', () => {
    const html = render(agent({ status: 'running', liveDetail: 'On scenario (f) [6/6]', subSteps: manySteps }))
    expect(html).toContain('On scenario (f) [6/6]')
    expect(html).toContain('running now')
    expect(html).toContain('>1 done<')
    expect(html).toContain('>+3 queued<')
    expect(html).not.toContain('border-state-working-border')
    expect(html).not.toContain('aria-live')
  })

  it('hides the heartbeat and sub-steps once the agent is no longer running', () => {
    const html = render(agent({ status: 'finished', liveDetail: 'stale', subSteps: manySteps }))
    expect(html).not.toContain('stale')
    expect(html).not.toContain('Sub-steps')
  })

  it('leaves no empty row or divider for an agent with none of the optional fields', () => {
    const html = render(agent({ status: 'running' }))
    expect(html).not.toMatch(/<p[ >]/)
    expect(html).not.toContain('Files touched')
    expect(html).not.toContain('border-t border-divider')
    expect(html).not.toContain('flex min-w-0 flex-wrap items-center gap-1"')
  })

  it('omits an empty file list and a blank trigger rather than rendering an empty row', () => {
    const html = render(agent({ filesTouched: [], triggeredBy: ' ' }))
    expect(html).not.toContain('Files touched')
    expect(html).not.toContain('fixes issue from')
  })

  it('draws a divider hairline and the surface-1 step, never the bare 3:1 control border (#2318, rule 1 and 7)', () => {
    const html = render(agent({ status: 'running', role: 'Gate', whatItDid: 'Done' }))
    expect(html).toContain('border-divider')
    expect(html).toContain('bg-surface-1')
    const tokens = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1]!.split(' '))
    expect(tokens).toContain('border')
    expect(tokens).not.toContain('border-border')
    expect(tokens).not.toContain('bg-surface-subtle')
  })

  it('renders the outcome through the shared Markdown, inert and embedded (#2242)', () => {
    const html = render(agent({ whatItDid: 'Fixed **two** defects' }))
    expect(html).toContain('data-md')
    expect(html).toContain('data-inert="true"')
    expect(html).toContain('data-embedded="true"')
  })
})

describe('SubagentCardBody flat (#2318, FR-176)', () => {
  it('is a left guide line with the role only: no name, status, outcome or border box', () => {
    const html = render(agent({ role: 'Accessibility Gate', whatItDid: 'Flagged one defect', duration: '2m' }), true)
    expect(html).toContain('border-l-2 border-divider')
    expect(html).toContain('Accessibility Gate')
    for (const gone of ['GateA11y', 'Flagged one defect', '2m', 'bg-surface-1']) expect(html).not.toContain(gone)
  })
})

describe('SubagentCardButton (#2318, FR-178)', () => {
  const button = (a: SubAgentItem = agent(), sessionId: string | null = 's1') =>
    renderToStaticMarkup(createElement(SubagentCardButton, { item: ITEM, agent: a, sessionId }))

  it('is one native button named "<agent>, <status>, open in Subagents panel" with no button inside it', () => {
    readout.subagents = [{ id: 'sa1', toolCallId: 't1', specIndex: 0 }]
    const html = button(agent({ filesTouched: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }))
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-label="GateA11y, Finished, open in Subagents panel"')
    expect(subagentCardButtonName(agent({ status: 'running' }))).toBe('GateA11y, Running, open in Subagents panel')
    expect(html).toContain('focus-visible:outline-ring')
  })

  it('renders a plain block, not a dead button, when the agent has no panel entry yet', () => {
    readout.subagents = []
    expect(button()).not.toContain('<button')
  })

  it('opens the panel on that agent with the button as the opener (what Enter, Space and click all run)', () => {
    const opener = {} as HTMLElement
    openSubagentInPanel('s1', { id: 'sa1', toolCallId: 't1', specIndex: 0 }, opener)
    expect(openHostedPanel).toHaveBeenCalledWith('subagents', 's1', { selectSubagentId: 'sa1', selectSubagentKey: 't1:0', opener })
  })
})
