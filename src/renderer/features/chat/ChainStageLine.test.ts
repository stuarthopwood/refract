// The repo has no jsdom: the Stage row is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
// Importing the real state barrel needs `window`; the row only reads the readout and display settings.
vi.mock('@/state', () => {
  const entry = { subagents: [] }
  const settings = { transcriptDisplay: { thinking: true, tools: true } }
  return {
    EMPTY_READOUT_ENTRY: entry,
    useReadoutStore: (select: (s: unknown) => unknown) => select({ bySession: {} }),
    useSettingsStore: (select: (s: unknown) => unknown) => select({ settings })
  }
})
vi.mock('../right-pane/hosted-panel-actions', () => ({ openHostedPanel: vi.fn() }))
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TranscriptSubagentItem } from '../subagents/viewModel/runs'
import { subagentItem } from '../subagents/viewModel/testFixtures'
import { ChainStageLine } from './ChainStageLine'
import { groupSubagentStages, isStageGroup, type StageGroup } from './groupSubagentStages'

function stageOf(items: TranscriptSubagentItem[]): StageGroup {
  const group = groupSubagentStages(items, []).find(isStageGroup)
  if (!group) throw new Error('no stage group')
  return group
}

function render(stage: StageGroup, expanded?: boolean): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChainStageLine, { stage, sessionId: null, expanded })))
}

const SOLO = () => stageOf([subagentItem({ name: 'Solo', result: 'Fixed the flaky test\nmore detail' })])
const GATE = () =>
  stageOf([
    subagentItem({ name: 'GateA', specIndex: 0, result: 'Passed' }),
    subagentItem({ name: 'GateB', specIndex: 1, result: 'Passed' })
  ])

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
    const html = render(GATE())

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

  describe('given the outcome line', () => {
    it('truncates to one line when collapsed and wraps in full when expanded', () => {
      expect(render(SOLO(), false)).toMatch(/class="[^"]*\btruncate\b[^"]*"[^>]*data-stage-outcome/)
      expect(render(SOLO(), true)).toMatch(/class="[^"]*\bbreak-words\b[^"]*"[^>]*data-stage-outcome/)
    })

    it('hides the agent rows but keeps the header, chip and badge when collapsed', () => {
      const collapsed = render(GATE(), false)
      expect(collapsed).toContain('2 parallel')
      expect(collapsed).not.toContain('<ol')
      expect(render(GATE(), true)).toContain('<ol')
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
})
