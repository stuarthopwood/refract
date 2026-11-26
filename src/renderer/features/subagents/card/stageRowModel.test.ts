import { describe, expect, it } from 'vitest'
import type { SubAgentItem } from '../viewModel/types'
import { stageAgentItemClass, stageAgentsGridClass, stageRowModel, type StageRowView } from './stageRowModel'

const agent = (name: string, overrides: Partial<SubAgentItem> = {}): SubAgentItem => ({
  id: name,
  key: `c:${name}`,
  toolCallId: 'c',
  specIndex: 0,
  name,
  status: 'finished',
  ...overrides
})

const view = (agents: SubAgentItem[], overrides: Partial<StageRowView> = {}): StageRowView => ({
  agents,
  cleanTitle: 'Gate' as string | null,
  status: 'finished' as const,
  ...overrides
})

describe('stageRowModel', () => {
  describe('given one agent', () => {
    it('shows it as the header chip and draws no parallel badge', () => {
      const model = stageRowModel(view([agent('Solo')]))
      expect(model.chipAgent?.name).toBe('Solo')
      expect(model.parallelCount).toBe(0)
    })
  })

  describe('given several agents', () => {
    it('counts them for the parallel badge and shows no chip', () => {
      const model = stageRowModel(view([agent('A'), agent('B'), agent('C')]))
      expect(model.chipAgent).toBeNull()
      expect(model.parallelCount).toBe(3)
    })
  })

  describe('given the outcome', () => {
    it('uses the settled outcome summary', () => {
      expect(stageRowModel(view([agent('A')], { outcomeSummary: ' Fixed it ' })).outcome).toBe('Fixed it')
    })

    it('falls back to a running agent focus while the Stage runs', () => {
      const running = agent('A', { status: 'running', liveDetail: 'Reading routes' })
      expect(stageRowModel(view([agent('B'), running], { status: 'running' })).outcome).toBe('Reading routes')
    })

    it('is absent when nothing is known, with no placeholder', () => {
      expect(stageRowModel(view([agent('A', { status: 'running' })], { status: 'running' })).outcome).toBeUndefined()
    })
  })

  describe('given the raw label', () => {
    it('keeps it for the tooltip only when it differs from the clean title', () => {
      expect(stageRowModel(view([agent('A')], { rawLabel: '## Rules (HARD) in C:/worktrees/x' })).rawLabel).toBe('## Rules (HARD) in C:/worktrees/x')
      expect(stageRowModel(view([agent('A')], { rawLabel: 'Gate' })).rawLabel).toBeUndefined()
      expect(stageRowModel(view([agent('A')])).rawLabel).toBeUndefined()
    })
  })
})

describe('stage agent layout classes', () => {
  it('lays a parallel Stage out in two columns from the card width (container query), not the viewport', () => {
    const grid = stageAgentsGridClass(2)
    expect(grid).toContain('@md:grid-cols-2')
    expect(grid).not.toMatch(/(^|\s)md:/)
    expect(stageAgentItemClass(2)).toContain('@md:even:')
  })

  it('leaves a one-agent or empty Stage as a single column', () => {
    expect(stageAgentsGridClass(0)).toBeUndefined()
    expect(stageAgentItemClass(0)).toBeUndefined()
  })
})
