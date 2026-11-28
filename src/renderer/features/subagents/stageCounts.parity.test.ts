// One Session fed to all three surfaces that count Stages and agents, which must read the same figures. The repo has no
// jsdom, so the composer pill is rendered to a string and its accessible name is read back.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// `@/state` registers dev handles and listeners on `window` as it loads, so the stub must land before the imports run.
vi.hoisted(() => {
  const noop = (): void => undefined
  vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
})

import { runningAgentCount } from '@/state/agents-store'
import { EMPTY_READOUT, useReadoutStore } from '@/state/readout-store'
import type { SubagentSummary } from '../../../shared/model'
import { SubagentsReadout } from '../chat/readout/Readouts'
import { countPill } from './stageCounts'
import { assistantText, subagentItem, subagentSummary } from './viewModel/testFixtures'
import { fromSummaries } from './viewModel/fromSummaries'
import { fromTranscript } from './viewModel/fromTranscript'
import { selectSubagentItems } from './viewModel/selectors'

const SESSION = 's1'

interface AgentSpec {
  name: string
  /** The owning assistant message: one Stage, however many `task()` calls it launched. */
  stage: 1 | 2
  /** Which `task()` call of the message launched the agent. */
  call?: 0 | 1
  /** Assistant text written just before this agent's call, between two calls of one message. */
  textBefore?: boolean
  specIndex: number
  status: SubagentSummary['status']
}

/** The same agents as the transcript shows them (the card) and as the registry lists them (the panel and the pill). */
function sessionOf(agents: AgentSpec[]) {
  const toolCallOf = (agent: AgentSpec) => `c${agent.stage}-${agent.call ?? 0}`
  const items = agents.flatMap((agent, index) => [
    // Text only before a message's first agent (or when asked), so a second call of the same message normally continues the run.
    ...(agents[index - 1]?.stage === agent.stage && !agent.textBefore ? [] : [assistantText(`t${index}`)]),
    subagentItem({
      name: agent.name,
      id: `${toolCallOf(agent)}:${agent.name}`,
      toolCallId: toolCallOf(agent),
      specIndex: agent.specIndex,
      messageId: `m${agent.stage}`,
      status: agent.status === 'running' ? 'running' : agent.status === 'finished' ? 'done' : 'error'
    })
  ])
  const subagents = agents.map((agent) =>
    subagentSummary({
      nameOrTask: agent.name,
      id: `${toolCallOf(agent)}:${agent.name}`,
      toolCallId: toolCallOf(agent),
      specIndex: agent.specIndex,
      stageKey: `m${agent.stage}`,
      status: agent.status
    })
  )
  return { items, subagents }
}

const stageCountOf = (headerStats: string) => Number(/(\d+) stages?/.exec(headerStats)?.[1] ?? 0)

/** The figures each surface shows for one Session. */
function surfacesFor(agents: AgentSpec[]) {
  const { items, subagents } = sessionOf(agents)
  const card = fromTranscript(items, subagents)
  const panel = fromSummaries(subagents, selectSubagentItems(items))
  const bySession = { [SESSION]: { readout: EMPTY_READOUT, subagents } }
  useReadoutStore.setState({ bySession })
  Object.assign(useReadoutStore.getInitialState(), { bySession })
  const pill = renderToStaticMarkup(createElement(SubagentsReadout, { sessionId: SESSION }))
  return {
    headerStats: card.headerStats,
    card,
    panel,
    cardStages: stageCountOf(card.headerStats),
    panelStages: stageCountOf(panel.headerStats),
    cardRunning: Number(/(\d+) running/.exec(card.headerStats)?.[1] ?? 0),
    panelRunning: runningAgentCount({ subagents }),
    pillRunning: Number(/Open subagents panel \((\d+) running\)/.exec(pill)?.[1] ?? 0),
    pillCounts: countPill(subagents),
    pillHtml: pill
  }
}

beforeEach(() => {
  useReadoutStore.setState({ bySession: {} })
})

describe('Stage and agent counts across the card, the Agents panel and the composer pill', () => {
  it('agree on one Session with a finished Stage and a running multi-agent Stage', () => {
    // Mutation: any surface counts running agents or Stages its own way (per Stage, per call, or only the last Stage).
    const surfaces = surfacesFor([
      { name: 'Alpha', stage: 1, specIndex: 0, status: 'finished' },
      { name: 'Beta', stage: 1, specIndex: 1, status: 'finished' },
      { name: 'Gamma', stage: 2, specIndex: 0, status: 'running' },
      { name: 'Delta', stage: 2, specIndex: 1, status: 'running' },
      { name: 'Epsilon', stage: 2, specIndex: 2, status: 'finished' }
    ])
    expect(surfaces.headerStats).toBe('2 stages, 5 agents, 2 running')
    expect([surfaces.cardRunning, surfaces.panelRunning, surfaces.pillRunning]).toEqual([2, 2, 2])
    expect([surfaces.cardStages, surfaces.panelStages]).toEqual([2, 2])
  })

  it('count two task() calls launched by one message as one Stage on the card and the panel, numbered without a gap', () => {
    // Mutation: group the panel by launching call, or number Stages by call, so one message becomes two Stages.
    const surfaces = surfacesFor([
      { name: 'Alpha', stage: 1, specIndex: 0, status: 'finished' },
      { name: 'Gamma', stage: 2, call: 0, specIndex: 0, status: 'running' },
      { name: 'Delta', stage: 2, call: 1, specIndex: 0, status: 'running' }
    ])
    expect(surfaces.headerStats).toBe('2 stages, 3 agents, 2 running')
    expect(surfaces.panel.headerStats).toBe(surfaces.headerStats)
    expect([surfaces.cardStages, surfaces.panelStages]).toEqual([2, 2])
    expect(surfaces.card.stages.map((stage) => stage.number)).toEqual([1, 2])
    expect(surfaces.panel.stages.map((stage) => stage.number)).toEqual([1, 2])
    expect(surfaces.panel.stages[1]!.agents.map((agent) => agent.name)).toEqual(['Gamma', 'Delta'])
    expect([surfaces.cardRunning, surfaces.panelRunning, surfaces.pillRunning]).toEqual([2, 2, 2])
  })

  it('count text between two task() calls of one message as one Stage numbered 1 on the card, the panel and the pill', () => {
    // Mutation: split the card's run on the text between the calls, so it counts 2 Stages while the panel and the pill count 1.
    const surfaces = surfacesFor([
      { name: 'Alpha', stage: 1, call: 0, specIndex: 0, status: 'running' },
      { name: 'Beta', stage: 1, call: 1, specIndex: 0, status: 'running', textBefore: true }
    ])
    expect(surfaces.headerStats).toBe('1 stage, 2 agents, 2 running')
    expect(surfaces.panel.headerStats).toBe(surfaces.headerStats)
    expect([surfaces.cardStages, surfaces.panelStages]).toEqual([1, 1])
    expect(surfaces.card.stages.map((stage) => stage.number)).toEqual([1])
    expect(surfaces.panel.stages.map((stage) => stage.number)).toEqual([1])
    expect(surfaces.card.stages[0]!.agents.map((agent) => agent.name)).toEqual(['Alpha', 'Beta'])
    expect([surfaces.cardRunning, surfaces.panelRunning, surfaces.pillRunning]).toEqual([2, 2, 2])
  })

  it('scope the pill to the whole last Stage, both calls of its message, once nothing runs', () => {
    // Mutation: scope the settled pill to the last call instead of the last Stage.
    const surfaces = surfacesFor([
      { name: 'Alpha', stage: 1, specIndex: 0, status: 'finished' },
      { name: 'Gamma', stage: 2, call: 0, specIndex: 0, status: 'finished' },
      { name: 'Delta', stage: 2, call: 1, specIndex: 0, status: 'failed' }
    ])
    expect(surfaces.pillCounts).toEqual({ running: 0, finished: 1, exited: 0, failed: 1, cancelled: 0 })
    expect(surfaces.card.stages[1]!.counts).toMatchObject({ finished: 1, failed: 1 })
    expect(surfaces.panel.stages[1]!.counts).toMatchObject({ finished: 1, failed: 1 })
    expect(surfaces.pillRunning).toBe(0)
  })

  it('count a multi-agent running Stage by its agents, not as one running Stage', () => {
    // Mutation: count each running Stage once instead of each running agent.
    const surfaces = surfacesFor([
      { name: 'Alpha', stage: 1, specIndex: 0, status: 'finished' },
      { name: 'Gamma', stage: 2, specIndex: 0, status: 'running' },
      { name: 'Delta', stage: 2, specIndex: 1, status: 'running' },
      { name: 'Epsilon', stage: 2, specIndex: 2, status: 'running' }
    ])
    expect(surfaces.headerStats).toBe('2 stages, 4 agents, 3 running')
    expect([surfaces.cardRunning, surfaces.panelRunning, surfaces.pillRunning]).toEqual([3, 3, 3])
    expect([surfaces.cardStages, surfaces.panelStages]).toEqual([2, 2])
  })

  it('all report nothing running once every agent settled, and the pill is gone', () => {
    // Mutation: the pill keeps a stale running figure after the last agent settles.
    const surfaces = surfacesFor([
      { name: 'Alpha', stage: 1, specIndex: 0, status: 'finished' },
      { name: 'Beta', stage: 1, specIndex: 1, status: 'finished' },
      { name: 'Gamma', stage: 2, specIndex: 0, status: 'finished' }
    ])
    expect(surfaces.headerStats).toBe('2 stages, 3 agents')
    expect([surfaces.cardRunning, surfaces.panelRunning, surfaces.pillRunning]).toEqual([0, 0, 0])
    expect([surfaces.cardStages, surfaces.panelStages]).toEqual([2, 2])
    expect(surfaces.pillHtml).toBe('')
  })
})
