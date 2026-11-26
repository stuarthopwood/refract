// The repo has no jsdom, so the card is rendered to a static string. Each test names the mutation that fails it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SubagentSummary } from '../../../shared/model'
import { assistantText, subagentItem, subagentSummary } from '../subagents/viewModel/testFixtures'
import { groupSubagentStages, isStageGroup, type StageGroup } from './groupSubagentStages'
import { SubagentChainRow } from './SubagentChainRow'

vi.mock('@/state', () => ({
  EMPTY_READOUT_ENTRY: { subagents: [] },
  useReadoutStore: (select: (state: { bySession: object }) => unknown) => select({ bySession: {} }),
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: { transcriptDisplay: { toolCalls: false } } }),
  useStageToggleStore: (select: (state: object) => unknown) => select({ bySession: {}, setManualOpen: () => undefined })
}))
vi.mock('../right-pane/hosted-panel-actions', () => ({ openHostedPanel: vi.fn() }))

function stagesFor(statuses: SubagentSummary['status'][], goals: (string | undefined)[] = []): StageGroup[] {
  const items = statuses.flatMap((status, index) => [
    assistantText(`t${index}`),
    subagentItem({ name: `A${index}`, id: `call${index}:A${index}`, toolCallId: `call${index}`, messageId: `m${index}`, status: status === 'running' ? 'running' : 'done' })
  ])
  const summaries = statuses.map((status, index) =>
    subagentSummary({ nameOrTask: `A${index}`, id: `call${index}:A${index}`, toolCallId: `call${index}`, status, ...(goals[index] ? { overallGoal: goals[index] } : {}) })
  )
  return groupSubagentStages(items, summaries).filter(isStageGroup)
}

const render = (stages: StageGroup[]) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SubagentChainRow, { stages, sessionId: null })))

describe('SubagentChainRow header', () => {
  it('renders nothing below two Stages', () => {
    // Mutation: drop the `stages.length < 2` early return.
    expect(render(stagesFor(['finished']))).toBe('')
  })

  it('reads "N stages, M agents" from the view-model and drops the "0 running" part once settled', () => {
    // Mutation: build the stats from local counts again, or stop filtering the zero part.
    const html = render(stagesFor(['finished', 'finished']))
    expect(html).toContain('2 stages, 2 agents')
    expect(html).not.toContain('0 running')
  })

  it('shows a segmented bar whose value text counts the done Stages', () => {
    // Mutation: count running Stages as done, or drop the segments.
    const html = render(stagesFor(['finished', 'running']))
    expect(html).toContain('aria-valuetext="1 of 2 stages done"')
    expect(html.match(/data-segment=/g)).toHaveLength(2)
  })

  it('leaves no Goal strip when no Stage carries a goal', () => {
    // Mutation: render the strip with an empty or derived goal.
    expect(render(stagesFor(['finished', 'finished']))).not.toContain('data-slot="goal-strip"')
  })
})

describe('SubagentChainRow goal strip', () => {
  it('shows the synthesised goal under the header when a Stage carries one', () => {
    // Mutation: drop the GoalStrip or stop feeding it the view-model's overallGoal.
    const html = render(stagesFor(['finished', 'finished'], ['Ship the card']))
    expect(html).toContain('data-slot="goal-strip"')
    expect(html).toContain('Ship the card')
  })
})
