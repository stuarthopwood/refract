// One Session fed to all three surfaces that count agents, which must read the same figures (#2299, FR-214). The repo has no
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
import { assistantText, subagentItem, subagentSummary } from './viewModel/testFixtures'
import { fromTranscript } from './viewModel/fromTranscript'

const SESSION = 's1'

interface AgentSpec {
  name: string
  /** The Stage's owning message and launching call. */
  stage: 1 | 2
  specIndex: number
  status: SubagentSummary['status']
}

/** The same agents as the transcript shows them (the card) and as the registry lists them (the panel and the pill). */
function sessionOf(agents: AgentSpec[]) {
  const items = agents.flatMap((agent, index) => [
    ...(agent.specIndex === 0 ? [assistantText(`t${index}`)] : []),
    subagentItem({
      name: agent.name,
      id: `c${agent.stage}:${agent.name}`,
      toolCallId: `c${agent.stage}`,
      specIndex: agent.specIndex,
      messageId: `m${agent.stage}`,
      status: agent.status === 'running' ? 'running' : agent.status === 'finished' ? 'done' : 'error'
    })
  ])
  const subagents = agents.map((agent) =>
    subagentSummary({ nameOrTask: agent.name, id: `c${agent.stage}:${agent.name}`, toolCallId: `c${agent.stage}`, specIndex: agent.specIndex, stageKey: `m${agent.stage}`, status: agent.status })
  )
  return { items, subagents }
}

/** The running count each surface shows for one Session. */
function surfacesFor(agents: AgentSpec[]) {
  const { items, subagents } = sessionOf(agents)
  const { headerStats } = fromTranscript(items, subagents)
  const bySession = { [SESSION]: { readout: EMPTY_READOUT, subagents } }
  useReadoutStore.setState({ bySession })
  Object.assign(useReadoutStore.getInitialState(), { bySession })
  const pill = renderToStaticMarkup(createElement(SubagentsReadout, { sessionId: SESSION }))
  return {
    headerStats,
    cardRunning: Number(/(\d+) running/.exec(headerStats)?.[1] ?? 0),
    panelRunning: runningAgentCount({ subagents }),
    pillRunning: Number(/Open subagents panel \((\d+) running\)/.exec(pill)?.[1] ?? 0),
    pillHtml: pill
  }
}

beforeEach(() => {
  useReadoutStore.setState({ bySession: {} })
})

describe('Stage and agent counts across the card, the Agents panel and the composer pill (#2299, FR-214)', () => {
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
    expect(surfaces.pillHtml).toBe('')
  })
})
