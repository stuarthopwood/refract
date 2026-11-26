// The repo has no jsdom: the panel's tree is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
// A server render reads zustand's INITIAL state, so the readout store is a plain selector over fixed state here.
const readout = vi.hoisted(() => ({ subagents: [] as unknown[] }))
vi.mock('@/state', () => {
  const entry = { subagents: [] }
  return {
    EMPTY_READOUT_ENTRY: entry,
    useReadoutStore: (select: (s: unknown) => unknown) => select({ bySession: { s1: { subagents: readout.subagents } } }),
    useSettingsStore: (select: (s: unknown) => unknown) => select({ settings: { transcriptDisplay: { thinking: true, tools: true } } }),
    useSyntaxTheme: () => 'github-dark'
  }
})
vi.mock('../right-pane/hosted-panel-actions', () => ({ openHostedPanel: vi.fn() }))
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SubagentSummary } from '../../../shared/model'
import { AgentDetailSummary, PanelHeader, PanelTree } from './SubagentPanelTree'
import { buildPanelRows } from './subagentPanelRows'
import { selectScenarioFromSummaries } from './viewModel'
import { subagentSummary } from './viewModel/testFixtures'

const noop = () => undefined

function render(summaries: SubagentSummary[], { open = true, selectedKey = null }: { open?: boolean; selectedKey?: string | null } = {}) {
  readout.subagents = summaries
  const scenario = selectScenarioFromSummaries(summaries)
  const rows = buildPanelRows(scenario.stages, () => open)
  const status = scenario.stages.some((stage) => stage.status === 'running') ? 'running' : 'finished'
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(PanelHeader, { scenario, status, durationMs: undefined }),
      createElement(PanelTree, { rows, selectedKey, tabbableIndex: 0, sessionId: 's1', rowRef: noop, onKeyDown: noop, onFocusRow: noop, onToggleStage: noop })
    )
  )
}

const PAIR = [
  subagentSummary({ nameOrTask: 'Alpha', toolCallId: 'c1', specIndex: 0, id: 'a' }),
  subagentSummary({ nameOrTask: 'Beta', toolCallId: 'c1', specIndex: 1, id: 'b', status: 'running' })
]

describe('PanelTree', () => {
  describe('given a parallel Stage', () => {
    const html = render(PAIR)

    it('draws the shared Stage header with the parallel badge and no single-agent chip', () => {
      expect(html).toContain('data-parallel-badge')
      expect(html).not.toContain('data-agent-chip')
    })

    it('keeps the treeitem model: Stage at level 1, agents at level 2', () => {
      expect(html).toContain('role="tree"')
      expect(html.match(/role="treeitem"[^>]*aria-level="1"/g)).toHaveLength(1)
      expect(html.match(/role="treeitem"[^>]*aria-level="2"/g)).toHaveLength(2)
    })

    it('shows the header stats and progress the card shows', () => {
      expect(html).toContain('1 stage, 2 agents, 1 running')
      expect(html).toContain('role="progressbar"')
    })
  })

  describe('given a one-agent Stage', () => {
    it('shows the agent as an inline chip', () => {
      expect(render([PAIR[0]!])).toContain('data-agent-chip')
    })
  })

  describe('selection', () => {
    it('marks only the selected agent selected and draws the active bar on it', () => {
      const html = render(PAIR, { selectedKey: 'c1:1' })
      expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
      expect(html.match(/aria-selected="false"/g)).toHaveLength(1)
      expect(html).toContain('aria-label="Beta, Running"')
    })

    it('draws no active bar and no selection when nothing is selected', () => {
      expect(render(PAIR)).not.toContain('aria-selected="true"')
    })
  })

  describe('expansion', () => {
    it('announces a Stage as expanded or collapsed and hides the agents of a closed one', () => {
      const closed = render(PAIR, { open: false })
      expect(closed).toContain('aria-expanded="false"')
      expect(closed).not.toContain('aria-level="2"')
      expect(render(PAIR)).toContain('aria-expanded="true"')
    })

    it('names the chevron for what it will do', () => {
      expect(render(PAIR, { open: false })).toMatch(/aria-label="Expand Stage 1/)
      expect(render(PAIR)).toMatch(/aria-label="Collapse Stage 1/)
    })
  })

  describe('background agents', () => {
    it('labels a detached job Background on its row and in its name', () => {
      const html = render([subagentSummary({ nameOrTask: 'Bg', id: 'bg', background: true })])
      expect(html).toContain('aria-label="Bg, Finished, Background"')
      expect(html).toMatch(/>Background</)
    })
  })

  describe('"Uses:" links', () => {
    it('lists the earlier Stage agents a later Stage depends on', () => {
      const html = render([
        subagentSummary({ nameOrTask: 'Producer', toolCallId: 'c1', specIndex: 0, id: 'p' }),
        subagentSummary({ nameOrTask: 'Consumer agent://Producer', toolCallId: 'c2', specIndex: 0, id: 'q' })
      ])
      expect(html).toContain('Uses:')
    })
  })
})

describe('PanelHeader', () => {
  it('names the group from the same label the card trigger uses', () => {
    expect(render(PAIR)).toContain('aria-label="Subagents, 1 stage, 2 agents, 1 running')
  })

  it('shows the goal strip when the scenario has one', () => {
    readout.subagents = PAIR
    const scenario = { ...selectScenarioFromSummaries(PAIR), overallGoal: 'Ship the release' }
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(PanelHeader, { scenario, status: 'running', durationMs: 65_000 })))
    expect(html).toContain('Ship the release')
    expect(html).toContain('1m')
  })
})

describe('PanelTree accessibility', () => {
  const [stage] = selectScenarioFromSummaries(PAIR).stages
  const detailed = { ...stage!.agents[0]!, role: 'Reviewer', duration: '2m', whatItDid: 'Found 3 issues', filesTouched: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }

  it('keeps the short aria-label and points aria-describedby at hidden outcome, role, duration and files text', () => {
    readout.subagents = PAIR
    const rows = buildPanelRows([{ ...stage!, agents: [detailed, stage!.agents[1]!] }], () => true)
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(PanelTree, { rows, selectedKey: null, tabbableIndex: 0, sessionId: 's1', rowRef: noop, onKeyDown: noop, onFocusRow: noop, onToggleStage: noop }))
    )
    const row = html.match(/<div[^>]*role="treeitem"[^>]*aria-label="Alpha, Finished"[^>]*>/)![0]
    const id = row.match(/aria-describedby="([^"]+)"/)![1]!
    expect(html).toContain(`<span id="${id}" hidden="">Reviewer. 2m. Found 3 issues. Files touched: a.ts, b.ts, c.ts, d.ts, e.ts, f.ts</span>`)
  })

  it('takes the nested "+N" files button out of the tab order inside a row', () => {
    const rows = buildPanelRows([{ ...stage!, agents: [detailed, stage!.agents[1]!] }], () => true)
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(PanelTree, { rows, selectedKey: null, tabbableIndex: 0, sessionId: 's1', rowRef: noop, onKeyDown: noop, onFocusRow: noop, onToggleStage: noop }))
    )
    expect(html).toMatch(/<button[^>]*tabindex="-1"[^>]*aria-expanded="false"/)
  })

  it('lets only the focused or selected agent row show its whole outcome', () => {
    const rows = buildPanelRows([{ ...stage!, agents: [detailed, stage!.agents[1]!] }], () => true)
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(PanelTree, { rows, selectedKey: null, tabbableIndex: 0, sessionId: 's1', rowRef: noop, onKeyDown: noop, onFocusRow: noop, onToggleStage: noop }))
    )
    const rowTokens = html.match(/<div[^>]*aria-level="2"[^>]*>/)![0].match(/class="([^"]*)"/)![1]!.split(' ')
    const outcomeTokens = html.match(/<p[^>]*class="([^"]*)"[^>]*>Found 3 issues<\/p>/)![1]!.split(' ')
    // The markup escapes `&` in the attribute, so the arbitrary variant reads `[&amp;_p]`.
    expect(rowTokens).toContain('aria-selected:[&amp;_p]:line-clamp-none')
    expect(rowTokens).toContain('focus:[&amp;_p]:line-clamp-none')
    const unscoped = rowTokens.filter((token) => token.endsWith('line-clamp-none') && !token.startsWith('aria-selected:') && !token.startsWith('focus:'))
    expect(unscoped).toEqual([])
    expect(outcomeTokens).toContain('line-clamp-2')
    expect(outcomeTokens).not.toContain('line-clamp-none')
  })

  it('lists every file and the whole outcome in the detail pane, with no "+N" fold', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AgentDetailSummary, { agent: detailed })))
    expect(html).toContain('Found 3 issues')
    expect(html).toContain('f.ts')
    expect(html).not.toContain('<button')
  })

  it('renders nothing for an agent with neither outcome nor files', () => {
    expect(renderToStaticMarkup(createElement(AgentDetailSummary, { agent: { ...detailed, whatItDid: undefined, filesTouched: undefined } }))).toBe('')
  })
})
