import { describe, expect, it } from 'vitest'
import {
  agentPanelAriaLabel,
  agentPanelDescription,
  buildPanelRows,
  isPanelStageOpen,
  panelDurationMs,
  panelKeyAction,
  panelStageToggleId,
  resolveSelectedKey,
  stageHoldsTarget,
  stageOfPendingFocus,
  stagePanelDescription,
  typeaheadIndex
} from './subagentPanelRows'
import { subagentSummary } from './viewModel/testFixtures'
import { selectScenarioFromSummaries } from './viewModel'

// Stage 1 is the pair "Alpha"/"Beta" (one call), Stage 2 is the solo "Gamma" (another call).
const scenario = () =>
  selectScenarioFromSummaries([
    subagentSummary({ nameOrTask: 'Alpha', toolCallId: 'c1', specIndex: 0, id: 'a' }),
    subagentSummary({ nameOrTask: 'Beta', toolCallId: 'c1', specIndex: 1, id: 'b', status: 'running' }),
    subagentSummary({ nameOrTask: 'Gamma', toolCallId: 'c2', specIndex: 0, id: 'g', background: true })
  ])
const NO_PENDING = { pendingFocusKey: null, pendingFocusId: null }

describe('panelStageToggleId', () => {
  it('is keyed apart from the chat card so toggling one never moves the other', () => {
    expect(panelStageToggleId('stage:c1')).toBe('panel:stage:c1')
    expect(panelStageToggleId('stage:c1')).not.toBe('card:stage:c1')
  })
})

describe('buildPanelRows', () => {
  it('lists a Stage row then its agents when open, with tree levels and positions', () => {
    const { stages } = scenario()
    const rows = buildPanelRows(stages, () => true)
    expect(rows.map((row) => [row.kind, row.label, row.depth, row.posinset, row.setsize])).toEqual([
      ['stage', stages[0]!.cleanTitle ?? 'Stage 1', 0, 1, 2],
      ['agent', 'Alpha', 1, 1, 2],
      ['agent', 'Beta', 1, 2, 2],
      ['stage', stages[1]!.cleanTitle ?? 'Stage 2', 0, 2, 2],
      ['agent', 'Gamma', 1, 1, 1]
    ])
  })

  it('drops the agents of a closed Stage', () => {
    const { stages } = scenario()
    const rows = buildPanelRows(stages, (stage) => stage.number === 2)
    expect(rows.map((row) => row.kind)).toEqual(['stage', 'stage', 'agent'])
  })

  it('gives a Stage the card wording and an agent its status and Background word', () => {
    const rows = buildPanelRows(scenario().stages, () => true)
    expect(rows[0]!.ariaLabel).toMatch(/^Stage 1/)
    expect(rows[0]!.ariaLabel).toContain('Running')
    const gamma = rows.find((row) => row.kind === 'agent' && row.label === 'Gamma')!
    expect(gamma.ariaLabel).toBe('Gamma, Finished, Background')
  })
})

describe('agentPanelAriaLabel', () => {
  it('omits Background for an ordinary agent', () => {
    const [stage] = scenario().stages
    expect(agentPanelAriaLabel(stage!.agents[0]!)).toBe('Alpha, Finished')
  })
})

describe('selection helpers', () => {
  const agents = scenario().stages.flatMap((stage) => stage.agents)

  it('prefers the store key while it still names an agent', () => {
    expect(resolveSelectedKey(agents, { selectedKey: 'c1:1', selectedId: 'a' })).toBe('c1:1')
  })

  it('falls back to the agent with the selected id, else null', () => {
    expect(resolveSelectedKey(agents, { selectedKey: 'gone', selectedId: 'g' })).toBe('c2:0')
    expect(resolveSelectedKey(agents, { selectedKey: null, selectedId: null })).toBeNull()
  })

  it('finds the Stage owning a requested agent by key, else by id', () => {
    const { stages } = scenario()
    expect(stageOfPendingFocus(stages, { pendingFocusKey: 'c2:0', pendingFocusId: null })).toBe(stages[1])
    expect(stageOfPendingFocus(stages, { pendingFocusKey: null, pendingFocusId: 'a' })).toBe(stages[0])
    expect(stageOfPendingFocus(stages, NO_PENDING)).toBeNull()
  })
})

describe('isPanelStageOpen', () => {
  const { stages } = scenario()
  const [running] = stages
  const settled = stages[1]!

  it('opens a running Stage and closes a settled one when nothing else asks', () => {
    expect(running!.status).toBe('running')
    expect(isPanelStageOpen(running!, undefined, null, NO_PENDING)).toBe(true)
    expect(isPanelStageOpen(settled, undefined, null, NO_PENDING)).toBe(false)
  })

  it('does not latch: a settled Stage closes again, unlike a sticky auto-open', () => {
    expect(isPanelStageOpen({ ...running!, status: 'finished' }, undefined, null, NO_PENDING)).toBe(false)
  })

  it("lets the developer's own toggle win over the automatic state", () => {
    expect(isPanelStageOpen(running!, false, null, NO_PENDING)).toBe(false)
    expect(isPanelStageOpen(settled, true, null, NO_PENDING)).toBe(true)
  })

  it('keeps a Stage open around the selected or requested agent', () => {
    expect(stageHoldsTarget(settled, 'c2:0', NO_PENDING)).toBe(true)
    expect(isPanelStageOpen(settled, undefined, 'c2:0', NO_PENDING)).toBe(true)
    expect(isPanelStageOpen(settled, undefined, null, { pendingFocusKey: null, pendingFocusId: 'g' })).toBe(true)
    expect(isPanelStageOpen(settled, undefined, null, { pendingFocusKey: 'other:0', pendingFocusId: 'g' })).toBe(false)
  })
})

describe('panelKeyAction', () => {
  const rows = buildPanelRows(scenario().stages, (stage) => stage.number === 1)
  // rows: stage1, Alpha, Beta, stage2 (closed)

  it('moves with the arrows, Home and End, stopping at the ends', () => {
    expect(panelKeyAction(rows, 0, 'ArrowDown')).toEqual({ type: 'focus', index: 1 })
    expect(panelKeyAction(rows, 3, 'ArrowDown')).toEqual({ type: 'focus', index: 3 })
    expect(panelKeyAction(rows, 0, 'ArrowUp')).toEqual({ type: 'focus', index: 0 })
    expect(panelKeyAction(rows, 2, 'Home')).toEqual({ type: 'focus', index: 0 })
    expect(panelKeyAction(rows, 0, 'End')).toEqual({ type: 'focus', index: 3 })
  })

  it('opens a closed Stage on ArrowRight, then steps into its first agent', () => {
    expect(panelKeyAction(rows, 3, 'ArrowRight')).toEqual({ type: 'toggle', stageId: rows[3]!.kind === 'stage' ? rows[3]!.stage.id : '', open: true })
    expect(panelKeyAction(rows, 0, 'ArrowRight')).toEqual({ type: 'focus', index: 1 })
  })

  it('closes an open Stage on ArrowLeft and returns an agent to its Stage', () => {
    expect(panelKeyAction(rows, 0, 'ArrowLeft')).toMatchObject({ type: 'toggle', open: false })
    expect(panelKeyAction(rows, 2, 'ArrowLeft')).toEqual({ type: 'focus', index: 0 })
    expect(panelKeyAction(rows, 3, 'ArrowLeft')).toBeNull()
  })

  it('toggles a Stage on Enter or Space and leaves an agent row alone', () => {
    expect(panelKeyAction(rows, 0, 'Enter')).toMatchObject({ type: 'toggle', open: false })
    expect(panelKeyAction(rows, 3, ' ')).toMatchObject({ type: 'toggle', open: true })
    expect(panelKeyAction(rows, 1, 'Enter')).toBeNull()
    expect(panelKeyAction(rows, 1, 'ArrowRight')).toBeNull()
  })

  it('ignores other keys and an index with no row', () => {
    expect(panelKeyAction(rows, 0, 'x')).toBeNull()
    expect(panelKeyAction(rows, 99, 'ArrowDown')).toBeNull()
  })
})

describe('typeaheadIndex', () => {
  const rows = buildPanelRows(scenario().stages, () => true)

  it('finds the next label starting with the buffer, wrapping, case-insensitively', () => {
    expect(typeaheadIndex(rows, 0, 'be')).toBe(2)
    expect(typeaheadIndex(rows, 4, 'al')).toBe(1)
  })

  it('returns -1 when nothing matches', () => {
    expect(typeaheadIndex(rows, 0, 'zzz')).toBe(-1)
  })
})

describe('agentPanelDescription (what the short name leaves out)', () => {
  const [stage] = scenario().stages
  const agent = { ...stage!.agents[0]!, role: 'Reviewer', duration: '2m', whatItDid: 'Found 3 issues', filesTouched: ['src/a.ts', 'src/b.ts', 'src/a.ts'] }

  it('joins role, duration, outcome and the whole file list', () => {
    expect(agentPanelDescription(agent)).toBe('Reviewer. 2m. Found 3 issues. Files touched: a.ts, b.ts')
  })

  it('leaves the ticking duration out while the agent runs', () => {
    expect(agentPanelDescription({ ...agent, status: 'running' })).not.toContain('2m')
  })

  it('is empty for an agent with nothing to add', () => {
    expect(agentPanelDescription({ ...agent, role: undefined, duration: undefined, whatItDid: undefined, filesTouched: undefined })).toBe('')
  })
})

describe('row descriptions', () => {
  it('gives a Stage the outcome line its header shows and an agent its own description', () => {
    for (const row of buildPanelRows(scenario().stages, () => true)) {
      expect(row.description).toBe(row.kind === 'stage' ? stagePanelDescription(row.stage) : agentPanelDescription(row.agent))
    }
  })
})

describe('panelDurationMs', () => {
  it('ticks from the first Stage while running', () => {
    expect(panelDurationMs({ startedAt: 1_000, totalDurationMs: 9 }, true, 6_000)).toBe(5_000)
  })

  it('never goes negative when the held clock is older than the first Stage', () => {
    expect(panelDurationMs({ startedAt: 9_000, totalDurationMs: 9 }, true, 6_000)).toBe(0)
  })

  it('uses the view-model total once settled, and nothing before a start is known', () => {
    expect(panelDurationMs({ startedAt: 1_000, totalDurationMs: 9 }, false, 6_000)).toBe(9)
    expect(panelDurationMs({ startedAt: undefined, totalDurationMs: 9 }, true, 6_000)).toBeUndefined()
  })
})
