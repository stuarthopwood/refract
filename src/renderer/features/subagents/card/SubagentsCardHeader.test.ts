// The repo has no jsdom, so the header is rendered to a static string. Each test names the mutation that fails it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ProgressSegmentState } from '@/components/ProgressStrip'
import type { SubagentRowStatus } from '../subagentStatus'
import { SubagentsCardHeader } from './SubagentsCardHeader'

// CollapsedLine imports the renderer state barrel, which needs a browser `window`.
vi.mock('@/state', () => ({ useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} }) }))

interface Over {
  status?: SubagentRowStatus
  headerStats?: string
  stageStates?: ProgressSegmentState[]
  goal?: string
  durationMs?: number
  open?: boolean
}

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
          stageStates: ['done', 'running', 'queued'],
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
    const html = render({ status: 'finished', headerStats: '3 stages, 5 agents', stageStates: ['done', 'done', 'done'] })
    expect(html).toContain('aria-label="Subagents, 3 stages, 5 agents, 1m 5s"')
    expect(html).not.toContain('Running')
  })

  it('draws one segment per Stage under a progressbar that reads "X of Y stages done"', () => {
    // Mutation: derive the done count from running Stages, or drop valueText.
    const html = render()
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuetext="1 of 3 stages done"')
    expect(html).toContain('1/3 done')
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
    const html = render({ stageStates: [] })
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
