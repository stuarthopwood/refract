// The repo has no jsdom: the panel's groups are rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/state', () => ({
  useSettingsStore: (select: (s: unknown) => unknown) => select({ settings: { transcriptDisplay: { thinking: true, tools: true } } }),
  useSyntaxTheme: () => 'github-dark'
}))
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentsGroup } from '../../../shared/ipc'
import { AgentDetailSummary, AgentsGroupSection, AgentsStatusLine } from './SubagentPanelTree'
import { buildGroupRows } from './subagentPanelRows'
import { selectScenarioFromSummaries } from './viewModel'
import { subagentSummary } from './viewModel/testFixtures'

const noop = () => undefined

function group(subagents: AgentsGroup['subagents'], overrides: Partial<AgentsGroup> = {}): AgentsGroup {
  return { sessionId: 's1', name: 'Fix login', status: 'working', subagents, ...overrides }
}

function render(subagents: AgentsGroup['subagents'], { collapsed = false, selectedKey = null, ...overrides }: { collapsed?: boolean; selectedKey?: string | null } & Partial<AgentsGroup> = {}) {
  const [rows] = buildGroupRows([group(subagents, overrides)])
  return renderToStaticMarkup(createElement(AgentsGroupSection, { group: rows!, collapsed, selectedKey, rowRef: noop, onSelect: noop, onToggle: noop }))
}

const MIXED = [
  subagentSummary({ nameOrTask: 'Alpha', toolCallId: 'c1', specIndex: 0, id: 'a', status: 'running' }),
  subagentSummary({ nameOrTask: 'Beta', toolCallId: 'c1', specIndex: 1, id: 'b', status: 'failed' }),
  subagentSummary({ nameOrTask: 'Gamma', toolCallId: 'c2', specIndex: 0, id: 'g' }),
  subagentSummary({ nameOrTask: 'Delta', toolCallId: 'c2', specIndex: 1, id: 'd' })
]

/** The markup's text content, as a screen reader would join it. */
const textOf = (html: string): string => {
  let text = html
  for (let prev = ''; prev !== text; ) {
    prev = text
    text = text.replace(/<[^>]*>/g, '')
  }
  return text
}

describe('AgentsGroupSection', () => {
  it('anchors the group by Session id for a later scroll-to', () => {
    expect(render(MIXED)).toContain('data-agents-group="s1"')
  })

  it('shows the Session name and running count on a header button that announces its state', () => {
    const html = render(MIXED)
    expect(html).toContain('Fix login')
    expect(html).toContain('1 running')
    expect(html).toMatch(/<button[^>]*aria-expanded="true"/)
    expect(render(MIXED, { collapsed: true })).toMatch(/<button[^>]*aria-expanded="false"/)
  })

  it('folds successful finishes into one line and keeps the running and failed rows', () => {
    const html = render(MIXED)
    expect(html).toContain('2 finished')
    expect(html).not.toContain('Gamma')
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
    expect(html).toContain('Failed')
  })

  it('gives each agent row an icon and a text status', () => {
    const html = render(MIXED)
    expect(html).toContain('Running')
    expect(html.match(/<svg/g)!.length).toBeGreaterThanOrEqual(3)
  })

  it('marks only the selected row current', () => {
    const html = render(MIXED, { selectedKey: 's1|c1:1' })
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
  })

  it('labels a detached job Background, set apart from its name', () => {
    const html = render([subagentSummary({ nameOrTask: 'Bg', id: 'bg', status: 'running', background: true })])
    expect(html).toMatch(/>Background</)
    expect(textOf(html)).toContain('Bg Background')
  })

  it('closes the list of a closed group but keeps the header', () => {
    const html = render(MIXED, { collapsed: true })
    expect(html).toMatch(/<button[^>]*data-state="closed"/)
    expect(html).not.toContain('<ul')
    expect(html).not.toContain('Alpha')
    expect(render(MIXED)).toMatch(/<ul[^>]*data-state="open"/)
  })

  it('keeps a space before the repository name in the accessible text', () => {
    const html = render(MIXED, { repositoryName: 'acme/web' })
    expect(textOf(html)).toContain('Fix login acme/web')
  })

  it('is not a named region landmark', () => {
    const html = render(MIXED)
    expect(html).not.toContain('aria-labelledby')
    expect(html).not.toContain('<section')
  })
})

describe('AgentsStatusLine', () => {
  it('is a polite live region with the running total', () => {
    const html = renderToStaticMarkup(createElement(AgentsStatusLine, { totalRunning: 3 }))
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('3 agents running')
  })

  it('shows the empty-state text when nothing runs', () => {
    expect(renderToStaticMarkup(createElement(AgentsStatusLine, { totalRunning: 0 }))).toContain('No agents running')
  })

  it('is the heading focus recovery lands on after a prune', () => {
    expect(renderToStaticMarkup(createElement(AgentsStatusLine, { totalRunning: 1 }))).toContain('data-panel-heading')
  })
})

describe('AgentDetailSummary', () => {
  const [stage] = selectScenarioFromSummaries([subagentSummary({ nameOrTask: 'Alpha', id: 'a' })]).stages
  const detailed = { ...stage!.agents[0]!, whatItDid: 'Found 3 issues', filesTouched: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }

  it('lists every file and the whole outcome, with no "+N" fold', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AgentDetailSummary, { agent: detailed })))
    expect(html).toContain('Found 3 issues')
    expect(html).toContain('f.ts')
    expect(html).not.toContain('<button')
  })

  it('makes a link in the outcome followable', () => {
    const linked = { ...detailed, whatItDid: 'Fixed in [the PR](https://x.test/pr)' }
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AgentDetailSummary, { agent: linked })))
    expect(html).toMatch(/<a[^>]*href="https:\/\/x\.test\/pr"/)
  })

  it('renders nothing for an agent with neither outcome nor files', () => {
    expect(renderToStaticMarkup(createElement(AgentDetailSummary, { agent: { ...detailed, whatItDid: undefined, filesTouched: undefined } }))).toBe('')
  })
})
