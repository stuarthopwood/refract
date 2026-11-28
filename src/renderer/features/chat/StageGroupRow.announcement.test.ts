// The polite status inside a Stage card announces when its last running agent settles. The repo has no jsdom, so the card is rendered to
// a string once per "tick"; effects and the one ref that remembers what ran are made to survive across those renders.
import { createElement } from 'react'
import type * as ReactModule from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { groupSubagentStages, isStageGroup, type StageGroup } from './groupSubagentStages'
import { StageGroupRow } from './SubagentChainRow'
import { assistantText, subagentItem } from '../subagents/viewModel/testFixtures'

const announced = vi.hoisted(() => ({ text: '' }))
const seenRunning = vi.hoisted(() => ({ ref: null as { current: Map<string, boolean> } | null }))

// Effects never run under renderToStaticMarkup, so they run inline; the settle hook's `Map` ref is kept so a later render sees the earlier one.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: (effect: () => void) => void effect(),
    useRef: (initial: unknown) => {
      if (!(initial instanceof Map)) return actual.useRef(initial)
      seenRunning.ref ??= { current: initial as Map<string, boolean> }
      return seenRunning.ref
    }
  }
})
vi.mock('@/lib/use-cleared-announcement', () => ({
  useClearedAnnouncement: () => [
    announced.text,
    (next: string) => {
      announced.text = next
    }
  ]
}))
vi.mock('@/state', () => ({
  EMPTY_READOUT_ENTRY: { subagents: [] },
  useReadoutStore: (select: (state: { bySession: object }) => unknown) => select({ bySession: {} }),
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: { transcriptDisplay: { toolCalls: false } } }),
  useSyntaxTheme: () => 'github-dark',
  useStageToggleStore: (select: (state: object) => unknown) => select({ bySession: {}, setManualOpen: () => undefined })
}))
// Their own effects set state on every inline run and never settle; the announcement does not depend on either.
vi.mock('./useStickyDisclosure', () => ({ useStickyDisclosure: () => ({ open: false, onOpenChange: () => undefined }) }))
vi.mock('@/components/FadeCollapse', () => ({ FadeCollapse: () => null }))
vi.mock('../right-pane/hosted-panel-actions', () => ({ openHostedPanel: vi.fn() }))

type AgentStatus = 'running' | 'done' | 'error'

/** One Stage whose two agents carry these statuses; the Stage id stays the same from one call to the next. */
function stageOf(...statuses: AgentStatus[]): StageGroup {
  const items = statuses.map((status, index) => subagentItem({ name: `Agent${index}`, id: `c1:Agent${index}`, toolCallId: 'c1', specIndex: index, status }))
  return groupSubagentStages([assistantText('t0'), ...items], []).find(isStageGroup)!
}

const render = (group: StageGroup): string => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(StageGroupRow, { group, sessionId: 's1' })))

/** What the card's polite status says in the markup of one render. */
function statusText(html: string): string {
  return /<span role="status" aria-live="polite" class="sr-only">([^<]*)<\/span>/.exec(html)?.[1] ?? 'no status span'
}

beforeEach(() => {
  announced.text = ''
  seenRunning.ref = null
})

describe('StageGroupRow settle announcement (#563)', () => {
  it('stays silent while the Stage runs, then says which Stage finished and how it ended once the last agent settles', () => {
    // Mutation: announce on every render, announce as soon as one agent settles, or drop the text from the status span.
    expect(statusText(render(stageOf('running', 'running')))).toBe('')
    expect(statusText(render(stageOf('done', 'running')))).toBe('')
    render(stageOf('done', 'done'))
    expect(statusText(render(stageOf('done', 'done')))).toBe('Stage 1 finished, 2 done')
  })

  it('names the shortfall when the Stage settles with a failed agent', () => {
    // Mutation: announce a failed Stage as plain success.
    render(stageOf('running', 'running'))
    render(stageOf('done', 'error'))
    expect(statusText(render(stageOf('done', 'error')))).toBe('Stage 1 finished, 1 done, 1 failed')
  })

  it('says nothing for a Stage first seen already settled, such as history loading', () => {
    // Mutation: treat a first sighting of a settled Stage as a settle.
    render(stageOf('done', 'done'))
    expect(statusText(render(stageOf('done', 'done')))).toBe('')
  })
})
