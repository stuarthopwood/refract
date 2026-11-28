// The repo has no jsdom, so the card is rendered to a static string. Each test names the mutation that fails it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SubagentSummary } from '../../../shared/model'
import { assistantText, subagentItem, subagentSummary } from '../subagents/viewModel/testFixtures'
import { groupSubagentStages, isStageGroup, type StageGroup } from './groupSubagentStages'
import { StageGroupRow, SubagentChainRow } from './SubagentChainRow'

// A server render reads zustand's INITIAL state, never a later `setState`, so the toggle store is a plain selector over mutable state.
const toggles = vi.hoisted(() => ({ bySession: {} as Record<string, Record<string, boolean>> }))
vi.mock('@/state', () => ({
  EMPTY_READOUT_ENTRY: { subagents: [] },
  useReadoutStore: (select: (state: { bySession: object }) => unknown) => select({ bySession: {} }),
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: { transcriptDisplay: { toolCalls: false } } }),
  useSyntaxTheme: () => 'github-dark',
  useStageToggleStore: (select: (state: object) => unknown) => select({ bySession: toggles.bySession, setManualOpen: () => undefined })
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

const render = (stages: StageGroup[], sessionId: string | null = null) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SubagentChainRow, { stages, sessionId })))

/** The developer opened the whole card by hand (its key is `chain:<first Stage id>`). */
const openCardByHand = (stages: StageGroup[], open: boolean) => {
  toggles.bySession = { s1: { [`chain:${stages[0]!.id}`]: open } }
}

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

const stageChevrons = (html: string): string[] =>
  (html.match(/<button[^>]*aria-label="Stage \d[^"]* agents"[^>]*>/g) ?? []).map((tag) => /aria-expanded="(true|false)"/.exec(tag)?.[1] ?? 'missing')
const cardTrigger = (html: string): string | undefined => (html.match(/<button[^>]*>/g) ?? []).find((tag) => tag.includes('2 stages'))

beforeEach(() => {
  toggles.bySession = {}
})

describe('SubagentChainRow Stage open state (FR-149)', () => {
  it('opens every running Stage when two run at once', () => {
    // Mutation: open only the first running Stage, or latch one open flag for the whole card.
    expect(stageChevrons(render(stagesFor(['running', 'running'])))).toEqual(['true', 'true'])
  })

  it('collapses only the Stage that settled and keeps the running one open', () => {
    // Mutation: derive each Stage's open state from the card's overall status.
    expect(stageChevrons(render(stagesFor(['finished', 'running'])))).toEqual(['false', 'true'])
  })

  it('shows every settled Stage collapsed when the developer opens a settled card', () => {
    // Mutation: latch a Stage open after it ran (the default hook mode).
    const stages = stagesFor(['finished', 'finished'])
    openCardByHand(stages, true)
    expect(stageChevrons(render(stages, 's1'))).toEqual(['false', 'false'])
  })

  it('keeps the card collapsed under the developer\'s own choice even while a Stage runs', () => {
    // Mutation: let the running state override the whole-card manual toggle.
    const stages = stagesFor(['running', 'running'])
    openCardByHand(stages, false)
    const html = render(stages, 's1')
    expect(stageChevrons(html)).toEqual([])
    expect(cardTrigger(html)).toContain('aria-expanded="false"')
  })

  it('gives the card its own disclosure button with aria-expanded, apart from the Stage chevrons', () => {
    // Mutation: drop aria-expanded from the card trigger or fold it into a Stage chevron.
    expect(cardTrigger(render(stagesFor(['running', 'running'])))).toContain('aria-expanded="true"')
  })
})

describe('StageGroupRow, a single-Stage turn (FR-175, FR-176)', () => {
  const renderRow = (group: StageGroup, sessionId: string | null = null) =>
    renderToStaticMarkup(createElement(TooltipProvider, null, createElement(StageGroupRow, { group, sessionId })))
  const visibleText = (html: string): string => html.replace(/<[^>]*>/g, ' ')

  it('draws the shared Stage header grid, not a separate collapsed line', () => {
    // Mutation: bring back the old CollapsedLine for a one-Stage turn.
    const html = renderRow(stagesFor(['finished'])[0]!)
    expect(html).toContain('grid-cols-[16px_1fr_auto]')
    expect(html).toContain('Stage 1')
  })

  it('shows no "N done" rollup text, in a solo or a parallel Stage', () => {
    // Mutation: render the rollup beside the title again.
    expect(visibleText(renderRow(stagesFor(['finished'])[0]!))).not.toMatch(/\d+ done/)
    const parallel = groupSubagentStages(
      [subagentItem({ name: 'GateA', specIndex: 0, result: 'Passed' }), subagentItem({ name: 'GateB', specIndex: 1, result: 'Passed' })],
      []
    ).find(isStageGroup)!
    const html = renderRow(parallel)
    expect(html).toContain('data-parallel-badge')
    expect(visibleText(html)).not.toMatch(/\d+ done/)
  })

  it('keeps one chevron button that reflects the collapsed state of a settled Stage', () => {
    // Mutation: drop aria-expanded from the chevron or open a settled Stage on its own.
    expect(stageChevrons(renderRow(stagesFor(['finished'])[0]!))).toEqual(['false'])
  })

  it('prints a failed solo Stage reason once, in the header outcome line, never again in the body (#2318)', () => {
    // Mutation: bring back the red failure paragraph under the expanded solo Stage.
    const reason = 'Boom: the fixture sweep failed hard.'
    const items = [subagentItem({ name: 'Solo', id: 'c1:Solo', toolCallId: 'c1', status: 'error', result: reason })]
    const summaries = [subagentSummary({ nameOrTask: 'Solo', id: 'c1:Solo', toolCallId: 'c1', status: 'failed' })]
    const group = groupSubagentStages(items, summaries).find(isStageGroup)!
    toggles.bySession = { s1: { [group.id]: true } }
    const html = renderRow(group, 's1')
    toggles.bySession = {}
    expect(visibleText(html).split('failed hard').length - 1).toBe(1)
  })

  it('mounts its own polite settle status inside the card, with no Show button until the agent is live (#1774)', () => {
    // Mutation: drop the status span from the card or render Show without a registry match.
    const html = renderRow(stagesFor(['finished'])[0]!, 's1')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('in Subagents panel')
  })
})
