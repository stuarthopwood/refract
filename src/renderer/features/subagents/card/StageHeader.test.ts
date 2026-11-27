// The repo has no jsdom: the header is rendered to a static string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
// CollapsedLine imports the renderer state barrel, which needs a browser `window`.
vi.mock('@/state', () => ({ useSettingsStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }))
import { TooltipProvider } from '@/components/ui/tooltip'
import { selectScenarioFromSummaries } from '../viewModel'
import { subagentSummary } from '../viewModel/testFixtures'
import { StageHeader, outcomeIsClamped } from './StageHeader'

const [stage] = selectScenarioFromSummaries([subagentSummary({ nameOrTask: 'Solo', toolCallId: 'c1', specIndex: 0, id: 'a', taskSummary: 'Fixed the flaky test' })]).stages

function render(props: { expanded?: boolean; columnFocusable?: boolean; fullOutcome?: boolean }): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(StageHeader, { stage: stage!, expanded: false, trailing: null, ...props })))
}

describe('StageHeader', () => {
  describe('given a focusable text column', () => {
    it('is a labelled group, so the outcome is never read without its Stage', () => {
      expect(render({ columnFocusable: true })).toMatch(/<div[^>]*tabindex="0"[^>]*role="group"[^>]*aria-label="Stage 1/)
    })

    it('is neither a tab stop nor a group otherwise', () => {
      const html = render({})
      expect(html).not.toContain('tabindex')
      expect(html).not.toContain('role="group"')
    })
  })

  describe('outcomeIsClamped', () => {
    it('clamps only a collapsed Stage nobody asked to read in full', () => {
      expect(outcomeIsClamped(false, false)).toBe(true)
      expect(outcomeIsClamped(true, false)).toBe(false)
      expect(outcomeIsClamped(false, true)).toBe(false)
    })

    it('draws the outcome without truncate once the full text is asked for', () => {
      expect(render({})).toMatch(/data-stage-outcome[^>]*>\s*<div[^>]*\[&amp;_p\]:truncate/)
      expect(render({ fullOutcome: true })).not.toMatch(/data-stage-outcome[^>]*>\s*<div[^>]*\[&amp;_p\]:truncate/)
    })
  })
})
