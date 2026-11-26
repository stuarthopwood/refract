import { describe, expect, it } from 'vitest'
import { deriveAgent, type AgentInput } from './derive'

const input = (overrides: Partial<AgentInput> = {}): AgentInput => ({
  id: 'c1:0',
  toolCallId: 'c1',
  specIndex: 0,
  name: 'A',
  status: 'running',
  ...overrides
})

describe('deriveAgent', () => {
  describe('given a running agent with recent steps', () => {
    const agent = deriveAgent(
      input({
        recentSteps: [
          { tool: 'read', target: 'a.ts', endMs: 2 },
          { tool: 'edit', intent: 'Fix the bug', target: 'b.ts' }
        ]
      }),
      undefined
    )

    it('keeps each sub-step status from whether it has ended', () => {
      expect(agent.subSteps?.map((s) => s.status)).toEqual(['done', 'running'])
    })

    it('shows the newest step as live detail', () => {
      expect(agent.liveDetail).toBe('Fix the bug b.ts')
    })

    it('labels a step by its intent, falling back to the tool', () => {
      expect(agent.subSteps?.map((s) => s.label)).toEqual(['read a.ts', 'Fix the bug b.ts'])
    })
  })

  describe('given an agent that is no longer running', () => {
    const agent = deriveAgent(input({ status: 'finished', recentSteps: [{ tool: 'edit', target: 'b.ts' }] }), undefined)

    it('forces every sub-step done even when its step never recorded an end', () => {
      expect(agent.subSteps).toEqual([{ label: 'edit b.ts', status: 'done' }])
    })

    it('omits live detail', () => {
      expect(agent).not.toHaveProperty('liveDetail')
    })
  })

  it('carries an error step flag through', () => {
    const agent = deriveAgent(input({ recentSteps: [{ tool: 'bash', endMs: 2, isError: true }] }), undefined)
    expect(agent.subSteps?.[0]).toMatchObject({ label: 'bash', isError: true })
  })

  it('omits an empty filesTouched and keeps a populated one', () => {
    expect(deriveAgent(input({ filesTouched: [] }), undefined)).not.toHaveProperty('filesTouched')
    expect(deriveAgent(input({ filesTouched: ['a.ts'] }), undefined).filesTouched).toEqual(['a.ts'])
  })

  it('omits sub-steps when there are no recent steps', () => {
    expect(deriveAgent(input(), undefined)).not.toHaveProperty('subSteps')
  })

  it('prefers the result summary over the task summary for what it did', () => {
    expect(deriveAgent(input({ resultSummary: 'Done it', taskSummary: 'Was asked' }), undefined).whatItDid).toBe('Done it')
    expect(deriveAgent(input({ taskSummary: 'Was asked' }), undefined).whatItDid).toBe('Was asked')
  })
})
