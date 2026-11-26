import { describe, expect, it } from 'vitest'
import { assistantText, subagentItem, subagentSummary } from '../subagents/viewModel/testFixtures'
import type { TranscriptItem } from '../../../shared/model'
import { groupTurnStages } from './groupTurnStages'

describe('groupTurnStages', () => {
  describe('given a turn with no subagent items', () => {
    const items = [assistantText('t1')]
    const first = groupTurnStages(items, true, [])

    it('keeps its result when only the readout summaries change', () => {
      expect(groupTurnStages(items, true, [subagentSummary({ nameOrTask: 'A' })])).toBe(first)
    })

    it('recomputes when its items array is replaced', () => {
      expect(groupTurnStages([...items], true, [])).not.toBe(first)
    })

    it('recomputes when the thinking display flips', () => {
      expect(groupTurnStages(items, false, [])).not.toBe(first)
    })
  })

  describe('given a turn with subagent items', () => {
    const items = [subagentItem({ name: 'A', status: 'running' })]
    const summaries = [subagentSummary({ nameOrTask: 'A', id: 'call1:A', status: 'running' })]
    const first = groupTurnStages(items, true, summaries)

    it('returns the same result for the same summaries', () => {
      expect(groupTurnStages(items, true, summaries)).toBe(first)
    })

    it('regroups when the summaries change and shows the new live state', () => {
      const next = groupTurnStages(items, true, [subagentSummary({ nameOrTask: 'A', id: 'call1:A', status: 'finished' })])
      expect(next).not.toBe(first)
      expect(next.stages[0]!.view.agents[0]!.status).toBe('finished')
      expect(first.stages[0]!.view.agents[0]!.status).toBe('running')
    })

    it('exposes the stage groups among the grouped rows', () => {
      expect(first.groupedWithStages.filter((row) => row.kind === 'stage-group')).toEqual(first.stages)
    })
  })

  describe('given a turn with a thinking item', () => {
    const items: TranscriptItem[] = [{ kind: 'thinking', id: 'th1', text: 'secret-musings', streaming: false }, assistantText('t1')]

    it('drops the thinking item when thinking is hidden and keeps it when shown', () => {
      expect(JSON.stringify(groupTurnStages(items, false, []).groupedWithStages)).not.toContain('secret-musings')
      expect(JSON.stringify(groupTurnStages(items, true, []).groupedWithStages)).toContain('secret-musings')
    })

    it('keeps its hidden-thinking result when only the readout summaries change', () => {
      const first = groupTurnStages(items, false, [])
      expect(groupTurnStages(items, false, [subagentSummary({ nameOrTask: 'A' })])).toBe(first)
    })
  })
})
