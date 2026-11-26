// The repo has no jsdom: the Stage row is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// Importing the real state barrel needs `window`, and a server render reads zustand's INITIAL state (never a later `setState`),
// so the toggle store is a plain selector over mutable state here.
const toggles = vi.hoisted(() => ({ bySession: {} as Record<string, Record<string, boolean>> }))
vi.mock('@/state', () => {
  const entry = { subagents: [] }
  const settings = { transcriptDisplay: { thinking: true, tools: true } }
  return {
    EMPTY_READOUT_ENTRY: entry,
    useReadoutStore: (select: (s: unknown) => unknown) => select({ bySession: {} }),
    useSettingsStore: (select: (s: unknown) => unknown) => select({ settings }),
    useSyntaxTheme: () => 'github-dark',
    useStageToggleStore: (select: (s: unknown) => unknown) => select({ bySession: toggles.bySession, setManualOpen: () => undefined })
  }
})
vi.mock('../right-pane/hosted-panel-actions', () => ({ openHostedPanel: vi.fn() }))
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TranscriptSubagentItem } from '../subagents/viewModel/runs'
import { subagentItem } from '../subagents/viewModel/testFixtures'
import { ChainStageLine, stageToggleRowId } from './ChainStageLine'
import { groupSubagentStages, isStageGroup, type StageGroup } from './groupSubagentStages'

const setManualOpen = (sessionId: string, rowId: string, open: boolean) => {
  toggles.bySession = { ...toggles.bySession, [sessionId]: { ...toggles.bySession[sessionId], [rowId]: open } }
}

function stageOf(items: TranscriptSubagentItem[]): StageGroup {
  const group = groupSubagentStages(items, []).find(isStageGroup)
  if (!group) throw new Error('no stage group')
  return group
}

function render(stage: StageGroup, sessionId: string | null = null): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChainStageLine, { stage, sessionId })))
}

const SOLO = () => stageOf([subagentItem({ name: 'Solo', result: 'Fixed the flaky test\nmore detail' })])
const GATE = () =>
  stageOf([
    subagentItem({ name: 'GateA', specIndex: 0, result: 'Passed' }),
    subagentItem({ name: 'GateB', specIndex: 1, result: 'Passed' })
  ])
const RUNNING_GATE = () =>
  stageOf([
    subagentItem({ name: 'GateA', specIndex: 0, status: 'running' }),
    subagentItem({ name: 'GateB', specIndex: 1, status: 'running' })
  ])

beforeEach(() => {
  toggles.bySession = {}
})

describe('ChainStageLine', () => {
  describe('given a one-agent Stage', () => {
    const html = render(SOLO())

    it('shows the clean title and the persistent one-line outcome', () => {
      expect(html).toContain('Stage 1 \u00b7 Solo')
      expect(html).toMatch(/data-stage-outcome[^>]*>Fixed the flaky test</)
    })

    it('shows the agent as an inline chip and no parallel badge', () => {
      expect(html).toContain('data-agent-chip')
      expect(html).not.toContain('data-parallel-badge')
    })
  })

  describe('given a parallel Stage', () => {
    const html = render(RUNNING_GATE())

    it('shows the "N parallel" badge and no inline chip', () => {
      expect(html).toContain('2 parallel')
      expect(html).toContain('2 agents in parallel')
      expect(html).not.toContain('data-agent-chip')
    })

    it('lays the expanded agents out through a card-width container query, not the viewport', () => {
      expect(html).toContain('@container')
      expect(html).toContain('@md:grid-cols-2')
    })
  })

  describe('given each agent in the Stage list', () => {
    it('renders it as a card, not a collapsed line', () => {
      const html = render(RUNNING_GATE())
      expect(html.match(/rounded-lg border bg-surface-subtle/g)).toHaveLength(2)
      expect(html).toContain('GateA')
      expect(html).toContain('GateB')
    })
  })
})

describe('ChainStageLine open state (FR-149)', () => {
  describe('given a settled Stage', () => {
    it('collapses it, hiding the agents but keeping the header, chip, badge and outcome', () => {
      const collapsed = render(GATE())
      expect(collapsed).toContain('2 parallel')
      expect(collapsed).toContain('data-stage-outcome')
      expect(collapsed).not.toContain('<ol')
      expect(render(SOLO())).not.toContain('<ol')
    })

    it('truncates the outcome to one line while collapsed', () => {
      expect(render(SOLO())).toMatch(/class="[^"]*\btruncate\b[^"]*"[^>]*data-stage-outcome/)
    })

    it('stays open once the developer opened it, and wraps the outcome in full', () => {
      const stage = SOLO()
      setManualOpen('s1', stageToggleRowId(stage.id), true)
      const html = render(stage, 's1')
      expect(html).toContain('<ol')
      expect(html).toMatch(/class="[^"]*\bbreak-words\b[^"]*"[^>]*data-stage-outcome/)
    })
  })

  describe('given a running Stage', () => {
    it('opens it on its own, with no developer toggle', () => {
      expect(render(RUNNING_GATE())).toContain('<ol')
    })

    it('stays collapsed once the developer collapsed it', () => {
      const stage = RUNNING_GATE()
      setManualOpen('s1', stageToggleRowId(stage.id), false)
      expect(render(stage, 's1')).not.toContain('<ol')
    })

    it('keeps a toggle in one Session from reaching the same Stage in another', () => {
      const stage = RUNNING_GATE()
      setManualOpen('s1', stageToggleRowId(stage.id), false)
      expect(render(stage, 's2')).toContain('<ol')
    })
  })

  describe('given the Stage header chevron', () => {
    it('is a button with aria-expanded reflecting the open state', () => {
      expect(render(RUNNING_GATE())).toMatch(/<button[^>]*aria-expanded="true"[^>]*aria-label="Stage 1[^"]* agents"/)
      expect(render(GATE())).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Stage 1[^"]* agents"/)
    })

    it('has no roving tabindex', () => {
      expect(render(RUNNING_GATE())).not.toContain('tabindex="-1"')
    })
  })

  describe('given an automatic expand or collapse', () => {
    it('is not announced as a log addition', () => {
      expect(render(RUNNING_GATE())).toContain('aria-live="off"')
    })
  })
})

describe('ChainStageLine reduced motion (FR-149 e)', () => {
  it('turns the running spinner and the chevron turn static', () => {
    const html = render(RUNNING_GATE())
    expect(html).toContain('motion-reduce:animate-none')
    expect(html).toContain('motion-reduce:transition-none')
  })
})

describe('given a running Stage', () => {
  const running = stageOf([subagentItem({ name: 'Solo', status: 'running' })])

  it('tints the header with a color-mix of the working state and draws no coloured border', () => {
    const html = render(running)
    expect(html).toContain('color-mix(in_oklab,var(--state-working)_10%,transparent)')
    expect(html).not.toMatch(/border-l-(state|severity)/)
    expect(html).toContain('data-status="running"')
  })

  it('does not tint a settled Stage', () => {
    expect(render(SOLO())).not.toContain('color-mix')
  })
})
