// The repo has no jsdom, so the header is rendered to a static string. Each test names the mutation that fails it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SubagentRowStatus } from '../subagentStatus'
import { stageSegmentLabels, stagesDoneText, SubagentsCardHeader, type StageLabelSource } from './SubagentsCardHeader'

// CollapsedLine imports the renderer state barrel, which needs a browser `window`.
vi.mock('@/state', () => ({ useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} }) }))

interface Over {
  status?: SubagentRowStatus
  headerStats?: string
  stages?: readonly StageLabelSource[]
  goal?: string
  durationMs?: number
  open?: boolean
}

const stageOf = (status: SubagentRowStatus, number: number): StageLabelSource => ({ number, cleanTitle: null, status, durationMs: undefined })
const THREE_STAGES = [stageOf('finished', 1), stageOf('running', 2), stageOf('parked', 3)]

const render = (over: Over = {}) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        SubagentsCardHeader,
        {
          status: 'running',
          headerStats: '3 stages, 5 agents, 1 running',
          stages: THREE_STAGES,
          durationMs: 65_000,
          open: true,
          onOpenChange: () => {},
          ...over
        },
        createElement('div', { id: 'stage-list' }, 'stages')
      )
    )
  )

describe('SubagentsCardHeader', () => {
  it('shows "Subagents", the stats and "Running" with the duration in the trigger', () => {
    // Mutation: drop the label, the stats or the status word from the trigger.
    const html = render()
    expect(html).toContain('Subagents')
    expect(html).toContain('3 stages, 5 agents, 1 running')
    expect(html).toContain('Running')
    expect(html).toContain('1m 5s')
  })

  it('hides the ticking duration from assistive tech and keeps it out of the trigger name', () => {
    // Mutation: put the duration in aria-label (it would change every second) or drop the aria-hidden wrapper.
    const html = render()
    expect(html).toContain('aria-label="Subagents, 3 stages, 5 agents, 1 running, Running"')
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>.*Running.*1m 5s/)
  })

  it('states the settled duration in the name and shows no status word for a finished run', () => {
    // Mutation: always append the status label, or drop the settled duration from the name.
    const html = render({ status: 'finished', headerStats: '3 stages, 5 agents', stages: [stageOf('finished', 1), stageOf('finished', 2), stageOf('finished', 3)] })
    expect(html).toContain('aria-label="Subagents, 3 stages, 5 agents, 1m 5s"')
    expect(html).not.toContain('Running')
  })

  it('draws one segment per Stage under a progressbar that reads "X of Y stages done"', () => {
    // Mutation: derive the done count from running Stages, or drop valueText.
    const html = render()
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuetext="1 of 3 stages done"')
    expect(html).toContain('1/3 stages done')
    expect(html.match(/data-segment=/g)).toHaveLength(3)
  })

  it('keeps the progressbar outside the trigger button so it stays exposed', () => {
    // Mutation: move the strip into `summary` or `meta` (a button's children are presentational).
    const html = render()
    const trigger = html.slice(html.indexOf('<button'), html.indexOf('</button>'))
    expect(trigger).not.toContain('progressbar')
  })

  it('renders the Goal strip only when a goal exists, leaving no gap otherwise', () => {
    // Mutation: always render the strip or fall back to a derived goal.
    expect(render({ goal: 'Ship the card' })).toContain('Ship the card')
    expect(render()).not.toContain('data-slot="goal-strip"')
  })

  it('renders the Stage list and omits the bar when there are no Stages', () => {
    // Mutation: drop children, or render an empty "0/0 done" bar.
    const html = render({ stages: [] })
    expect(html).toContain('id="stage-list"')
    expect(html).not.toContain('progressbar')
  })

  it('uses card tokens, never the mock palette', () => {
    // Mutation: copy zinc-* or hex colours from the design mock.
    const html = render()
    expect(html).toContain('bg-chat-card-bg')
    expect(html).toContain('ring-divider')
    expect(html).not.toMatch(/zinc-|emerald-|#0d0d10/)
  })
})

describe('stagesDoneText', () => {
  it('announces for the chat card and stays silent for the panel', () => {
    // Mutation: ignore the flag (both surfaces would announce at once) or drop the card's text.
    expect(stagesDoneText(true)).toBe('All stages done')
    expect(stagesDoneText(false)).toBeUndefined()
  })
})

describe('stageSegmentLabels', () => {
  const stages = [
    { number: 3, cleanTitle: 'Fix the build', status: 'finished', durationMs: 833_000 },
    { number: 4, cleanTitle: null, status: 'running', durationMs: undefined },
    { number: 7, cleanTitle: 'Ship', status: 'failed', durationMs: 5_000 }
  ] as const

  it('reads "Stage N · title · status · duration", dropping the missing parts', () => {
    // Mutation: number from the array index, or keep a trailing separator when there is no duration.
    expect(stageSegmentLabels(stages)).toEqual(['Stage 3 · Fix the build · Finished · 13m 53s', 'Stage 4 · Running', 'Stage 7 · Ship · Failed · 5s'])
  })

  it('puts one tooltip label per segment into the header, numbered from the Stage, not the position', () => {
    // Mutation: pass no labels, or number by position.
    const html = render({ stages })
    expect(html).toContain('<li>Stage 7 · Ship · Failed · 5s</li>')
    expect(html).toMatch(/role="progressbar"[^>]*aria-describedby=/)
  })

  it('gives every segment a label and a count from the same list, so none can be dropped', () => {
    // Mutation: build the segments and the labels from two separately maintained arrays.
    const html = render({ stages })
    expect(html.match(/data-segment=/g)).toHaveLength(3)
    expect(html.match(/<li>/g)).toHaveLength(3)
    expect(html).toContain('1/3 stages done')
  })
})
