import { describe, expect, it } from 'vitest'
import type { SubAgentItem } from '../viewModel/types'
import { stageAccessibleName, stageAgentsGridClass, stageRowModel, type StageRowView } from './stageRowModel'

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

describe('stageAccessibleName', () => {
  const stage = { number: 2, cleanTitle: 'Gate' as string | null, rollupText: '3 done', status: 'finished' as const, durationMs: undefined as number | undefined }

  it('joins the heading and the roll-up, with no status word for a settled Stage', () => {
    expect(stageAccessibleName(stage)).toBe('Stage 2, Gate, 3 done')
  })

  it('adds "Running" while running and leaves the ticking duration out', () => {
    expect(stageAccessibleName({ ...stage, status: 'running', durationMs: 65_000 })).toBe('Stage 2, Gate, 3 done, Running')
  })

  it('adds the duration once the Stage has settled', () => {
    expect(stageAccessibleName({ ...stage, durationMs: 65_000 })).toMatch(/^Stage 2, Gate, 3 done, 1m/)
  })

  it('falls back to the bare Stage number without a title', () => {
    expect(stageAccessibleName({ ...stage, cleanTitle: null })).toBe('Stage 2, 3 done')
  })
})

describe('stage agent layout classes', () => {
  it('lays a parallel Stage out in two columns from the card width (container query), not the viewport', () => {
    const grid = stageAgentsGridClass(2)
    expect(grid).toContain('@md:grid-cols-2')
    expect(grid).not.toMatch(/(^|\s)md:/)
    expect(grid).toContain('@md:grid')
  })

  it('leaves a one-agent or empty Stage as a single column', () => {
    expect(stageAgentsGridClass(0)).toBeUndefined()
    expect(stageAgentsGridClass(1)).toBeUndefined()
  })
})
