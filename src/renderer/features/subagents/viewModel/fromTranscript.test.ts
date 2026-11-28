import { describe, expect, it } from 'vitest'
import { formatElapsed } from '../../chat/formatElapsed'
import { fromTranscript } from './fromTranscript'
import { assistantText, subagentItem, subagentSummary } from './testFixtures'

describe('fromTranscript', () => {
  describe('given one run of parallel agents', () => {
    const scenario = fromTranscript(
      [
        subagentItem({ name: 'GateA', specIndex: 0, startedAt: 1000, durationMs: 2000, result: '## Passed a11y scan\nmore' }),
        subagentItem({ name: 'GateB', specIndex: 1, startedAt: 2000, durationMs: 5000, status: 'error' })
      ],
      []
    )
    const stage = scenario.stages[0]!

    it('builds one parallel stage with per-agent outcome and the shared-name title', () => {
      expect(scenario.stages).toHaveLength(1)
      expect(stage).toMatchObject({ id: 'stage:call1:GateA', number: 1, isParallel: true, isSingleAgent: false, cleanTitle: 'Gate' })
      expect(stage.agents[0]).toMatchObject({ name: 'GateA', whatItDid: 'Passed a11y scan', status: 'finished' })
      expect(stage.agents[1]).toMatchObject({ name: 'GateB', status: 'failed' })
    })

    it('derives counts, roll-up, header stats and the whole-run duration', () => {
      expect(stage.rollupText).toBe('1 done, 1 failed')
      expect(scenario.headerStats).toBe('1 stage, 2 agents, 1 failed')
      expect(scenario.totalDurationMs).toBe(6000)
      expect(scenario.totalDuration).toBe(formatElapsed(6000))
      // Mutation: draw "1 done, 1 failed" again -- a settled Stage adds no "N done" line, only its shortfall (#2318).
      expect(stage.outcomeSummary).toBe('1 failed')
    })
  })

  describe('given a parallel Stage with no failures (#2318, FR-176)', () => {
    it('draws no "N done" line once every agent has finished', () => {
      // Mutation: put the roll-up back as the outcome.
      const settled = fromTranscript([0, 1, 2].map((index) => subagentItem({ name: `Gate${index}`, specIndex: index, status: 'done' })), []).stages[0]!
      expect(settled).not.toHaveProperty('outcomeSummary')
      expect(settled.rollupText).toBe('3 done')
    })

    it('draws "1/3 done" while it runs, and keeps the spoken roll-up', () => {
      const statuses = ['done', 'running', 'running'] as const
      const running = fromTranscript(statuses.map((status, index) => subagentItem({ name: `Gate${index}`, specIndex: index, status })), []).stages[0]!
      expect(running.outcomeSummary).toBe('1/3 done')
      expect(running.rollupText).toBe('1 of 3 done')
    })
  })

  describe('given a single agent', () => {
    it('uses the single-agent layout and the agent result as the outcome', () => {
      const stage = fromTranscript([subagentItem({ name: 'Solo', result: 'Fixed it' })], []).stages[0]!
      expect(stage).toMatchObject({ isSingleAgent: true, isParallel: false, outcomeSummary: 'Fixed it', cleanTitle: 'Solo' })
    })
  })

  describe('given stages separated by another item or message', () => {
    const scenario = fromTranscript(
      [
        subagentItem({ name: 'A1', id: 'a1', messageId: 'm1', toolCallId: 'c1' }),
        assistantText('t'),
        subagentItem({ name: 'B1', id: 'b1', messageId: 'm2', toolCallId: 'c2', task: 'Use agent://A1 output', specIndex: 0 })
      ],
      []
    )

    it('makes one stage per run, numbered in order', () => {
      expect(scenario.stages.map((s) => s.number)).toEqual([1, 2])
      expect(scenario.headerStats).toBe('2 stages, 2 agents')
    })

    it('records which earlier agent a later stage uses as triggeredBy', () => {
      expect(scenario.stages[1]!.agents[0]!.triggeredBy).toBe('A1')
      expect(scenario.stages[0]!.agents[0]).not.toHaveProperty('triggeredBy')
    })
  })

  describe('given summaries overlaying the items', () => {
    const items = [subagentItem({ name: 'A', status: 'running', role: 'From cache', overallGoal: 'Cache goal', startedAt: 1, durationMs: 10 })]

    it('lets the summary win on every field both carry', () => {
      const [agent] = fromTranscript(items, [
        subagentSummary({ nameOrTask: 'A', status: 'finished', role: 'Live role', overallGoal: 'Live goal', startedAt: 5, durationMs: 99, background: true })
      ]).stages[0]!.agents
      expect(agent).toMatchObject({ status: 'finished', role: 'Live role', durationMs: 99, startedAt: 5, background: true })
    })

    it('falls back to the item value when the summary omits the field', () => {
      const scenario = fromTranscript(items, [subagentSummary({ nameOrTask: 'A' })])
      expect(scenario.stages[0]!.agents[0]!.role).toBe('From cache')
      expect(scenario.overallGoal).toBe('Cache goal')
    })

    it('renders an item with no summary from the item alone, and ignores a summary with no item', () => {
      const scenario = fromTranscript(items, [subagentSummary({ nameOrTask: 'Z', toolCallId: 'other', status: 'failed' })])
      expect(scenario.stages).toHaveLength(1)
      expect(scenario.stages[0]!.agents[0]).toMatchObject({ name: 'A', status: 'running', role: 'From cache' })
    })

    it('matches on toolCallId plus specIndex, not on name', () => {
      const two = [subagentItem({ name: 'Same', specIndex: 0 }), subagentItem({ name: 'Same', id: 'x', specIndex: 1 })]
      const stage = fromTranscript(two, [subagentSummary({ nameOrTask: 'Same', specIndex: 1, status: 'failed' })]).stages[0]!
      expect(stage.agents.map((a) => a.status)).toEqual(['finished', 'failed'])
    })

    it('keeps a background agent running until its summary settles, then follows the summary', () => {
      const spawned = [subagentItem({ name: 'Bg', status: 'running' })]
      const stillRunning = fromTranscript(spawned, [subagentSummary({ nameOrTask: 'Bg', status: 'running', background: true })]).stages[0]!.agents[0]!
      const settled = fromTranscript(spawned, [subagentSummary({ nameOrTask: 'Bg', status: 'finished', background: true })]).stages[0]!.agents[0]!
      expect([stillRunning.status, settled.status]).toEqual(['running', 'finished'])
    })

    it('does not reopen an agent the transcript settled when a stale summary still says running', () => {
      const [agent] = fromTranscript([subagentItem({ name: 'A', status: 'done' })], [subagentSummary({ nameOrTask: 'A', status: 'running' })]).stages[0]!.agents
      expect(agent!.status).toBe('finished')
    })

    it('passes the summary cardSummary through and prefers it for what the agent did', () => {
      const [agent] = fromTranscript(items, [subagentSummary({ nameOrTask: 'A', cardSummary: 'Fixed the login bug' })]).stages[0]!.agents
      expect(agent!.whatItDid).toBe('Fixed the login bug')
    })

    it('numbers Stages with the Session numbering when given', () => {
      const scenario = fromTranscript(items, [], new Map([['m1', 4]]))
      expect(scenario.stages[0]!.number).toBe(4)
    })
  })

  describe('given live steps from the summary', () => {
    const steps = [{ tool: 'read', target: 'a.ts', endMs: 5 }, { tool: 'edit', intent: 'Fix bug', target: 'b.ts' }]
    const running = fromTranscript([subagentItem({ name: 'A', status: 'running' })], [subagentSummary({ nameOrTask: 'A', status: 'running', recentSteps: steps, filesTouched: ['b.ts'] })]).stages[0]!.agents[0]!

    it('shows the newest step as liveDetail and maps steps to subSteps', () => {
      expect(running.liveDetail).toBe('Fix bug b.ts')
      expect(running.subSteps).toEqual([
        { label: 'read a.ts', status: 'done' },
        { label: 'Fix bug b.ts', status: 'running' }
      ])
      expect(running.filesTouched).toEqual(['b.ts'])
    })

    it('shows no liveDetail and only done steps once the agent has settled', () => {
      const settled = fromTranscript([subagentItem({ name: 'A' })], [subagentSummary({ nameOrTask: 'A', recentSteps: steps })]).stages[0]!.agents[0]!
      expect(settled).not.toHaveProperty('liveDetail')
      expect(settled.subSteps!.every((s) => s.status === 'done')).toBe(true)
    })

    it('flags a failed step', () => {
      const failed = fromTranscript([subagentItem({ name: 'A' })], [subagentSummary({ nameOrTask: 'A', recentSteps: [{ tool: 'bash', isError: true, endMs: 1 }] })]).stages[0]!.agents[0]!
      expect(failed.subSteps).toEqual([{ label: 'bash', status: 'done', isError: true }])
    })
  })

  describe('given no optional fields anywhere', () => {
    it('omits them rather than emitting undefined or empty values', () => {
      const scenario = fromTranscript([subagentItem({ name: 'A', status: 'running' })], [])
      const agent = scenario.stages[0]!.agents[0]!
      for (const key of ['role', 'whatItDid', 'filesTouched', 'liveDetail', 'subSteps', 'triggeredBy', 'durationMs', 'duration', 'background']) {
        expect(agent).not.toHaveProperty(key)
      }
      for (const key of ['overallGoal', 'totalDurationMs', 'totalDuration']) expect(scenario).not.toHaveProperty(key)
      expect(scenario.stages[0]).not.toHaveProperty('outcomeSummary')
    })
  })

  it('cleans the stage title and keeps the raw first line', () => {
    const stage = fromTranscript([subagentItem({ name: 'A', context: 'Repo C:\\x\\worktrees\\y\nGoal: Audit login' })], []).stages[0]!
    expect(stage.cleanTitle).toBe('Audit login')
    expect(stage.rawLabel).toContain('worktrees')
  })

  it('returns an empty scenario for no subagent items', () => {
    expect(fromTranscript([assistantText('t')], [])).toMatchObject({ stages: [], headerStats: '0 stages, 0 agents' })
  })
})
