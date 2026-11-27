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
import { panelStageToggleId } from '../subagents/subagentPanelRows'
import { ChainStageLine, shouldMoveFocusToChevron, stageToggleRowId } from './ChainStageLine'
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
      expect(html).toContain('Stage 1')
      expect(html).toMatch(/data-stage-outcome[^>]*>[\s\S]*?<p[^>]*>Fixed the flaky test<\/p>/)
    })

    it('shows no agent chip when the name only repeats the Stage title, and no parallel badge', () => {
      expect(html).not.toContain('data-agent-chip')
      expect(html).not.toContain('data-parallel-badge')
    })
  })

  describe('given a parallel Stage', () => {
    const html = render(RUNNING_GATE())

    it('shows the bare-count parallel badge with a screen-reader name and no inline chip', () => {
      expect(html).toContain('data-parallel-badge')
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
      expect(html.match(/rounded-lg border border-divider bg-surface-1/g)).toHaveLength(2)
      expect(html).not.toContain('bg-surface-subtle')
      expect(html).toContain('GateA')
      expect(html).toContain('GateB')
    })
  })
})

describe('ChainStageLine open state (FR-149)', () => {
  describe('given a settled Stage', () => {
    it('collapses it, hiding the agents but keeping the header, chip and badge, with no "N done" subline (#2318, FR-176)', () => {
      const collapsed = render(GATE())
      expect(collapsed).toContain('data-parallel-badge')
      expect(collapsed).not.toContain('data-stage-outcome')
      expect(collapsed).not.toContain('<ol')
      expect(render(SOLO())).not.toContain('<ol')
    })

    it('truncates the outcome to one line while collapsed', () => {
      expect(render(SOLO())).toMatch(/data-stage-outcome[^>]*>\s*<div[^>]*\[&amp;_p\]:truncate/)
    })

    it('stays open once the developer opened it, and wraps the outcome in full', () => {
      const stage = SOLO()
      setManualOpen('s1', stageToggleRowId(stage.id), true)
      const html = render(stage, 's1')
      expect(html).toContain('<ol')
      expect(html).not.toMatch(/data-stage-outcome[^>]*>\s*<div[^>]*\[&amp;_p\]:truncate/)
      expect(html).toMatch(/data-stage-outcome[^>]*>[\s\S]*?<p[^>]*>Fixed the flaky test<\/p>/)
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
    it('is not announced as a log addition, and the running outcome line never speaks', () => {
      expect(render(RUNNING_GATE())).toMatch(/<div role="group"[^>]*aria-live="off"[^>]*data-status="running"/)
    })
  })

  describe('given focus inside a Stage that auto-collapses', () => {
    it('hands it to the chevron only on an expanded-to-collapsed change with focus in the content', () => {
      expect(shouldMoveFocusToChevron(true, false, true)).toBe(true)
      expect(shouldMoveFocusToChevron(true, false, false)).toBe(false)
      expect(shouldMoveFocusToChevron(false, false, true)).toBe(false)
      expect(shouldMoveFocusToChevron(true, true, true)).toBe(false)
      expect(shouldMoveFocusToChevron(false, true, true)).toBe(false)
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

  it('tints the header with the working-state tint token and draws no coloured border', () => {
    const html = render(running)
    expect(html).toContain('bg-state-working-tint')
    expect(html).not.toMatch(/border-l-(state|severity)/)
    expect(html).toContain('data-status="running"')
  })

  it('does not tint a settled Stage', () => {
    expect(render(SOLO())).not.toContain('bg-state-working-tint')
  })
})

describe('Stage toggle keys (FR-150 d)', () => {
  it('keeps the card and the panel on separate keys', () => {
    const stage = GATE()
    expect(stageToggleRowId(stage.id)).toBe(`card:${stage.id}`)
    expect(panelStageToggleId(stage.id)).toBe(`panel:${stage.id}`)
  })

  it('leaves a settled card collapsed when only the panel opened that Stage', () => {
    const stage = GATE()
    setManualOpen('s1', panelStageToggleId(stage.id), true)
    expect(render(stage, 's1')).not.toContain('<ol')
  })

  it('leaves the panel key untouched when the card opens that Stage', () => {
    const stage = GATE()
    setManualOpen('s1', stageToggleRowId(stage.id), true)
    expect(toggles.bySession.s1?.[panelStageToggleId(stage.id)]).toBeUndefined()
    expect(render(stage, 's1')).toContain('<ol')
  })
})
