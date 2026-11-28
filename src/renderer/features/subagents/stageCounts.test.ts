import { describe, expect, it } from 'vitest'
import { countPill } from './stageCounts'
import type { SubagentSummary } from '../../../shared/model'

type Entry = Pick<SubagentSummary, 'toolCallId' | 'stageKey' | 'status'>
const entry = (stageKey: string, status: SubagentSummary['status'], toolCallId = stageKey): Entry => ({ toolCallId, stageKey, status })

describe('countPill', () => {
  it('returns nothing for an empty list', () => {
    expect(countPill([])).toBeNull()
  })

  it('counts every Stage while anything runs', () => {
    // Mutation: scope a running Session to its last Stage only.
    const counts = countPill([entry('m1', 'finished'), entry('m2', 'running')])
    expect(counts).toEqual({ running: 1, finished: 1, exited: 0, failed: 0, cancelled: 0 })
  })

  it('returns nothing once the last Stage finished cleanly', () => {
    // Mutation: keep a pill for finished work.
    expect(countPill([entry('m1', 'failed'), entry('m2', 'finished')])).toBeNull()
  })

  it('keeps a pill when nothing runs and the last Stage has a failed agent', () => {
    // Mutation: drop the failure check, so a failure is silent.
    expect(countPill([entry('m1', 'finished'), entry('m2', 'finished'), entry('m2', 'failed', 'call-b')])).toEqual({
      running: 0, finished: 1, exited: 0, failed: 1, cancelled: 0
    })
  })

  it('keeps a pill when nothing runs and the last Stage has an exited agent', () => {
    // Mutation: check only `failed`, so an exit is silent.
    expect(countPill([entry('m1', 'exited')])).toEqual({ running: 0, finished: 0, exited: 1, failed: 0, cancelled: 0 })
  })

  it('treats two calls of one message as one Stage', () => {
    // Mutation: group by launching call, so the settled scope drops the earlier call.
    const counts = countPill([entry('m1', 'finished', 'call-a'), entry('m1', 'failed', 'call-b')])
    expect(counts).toMatchObject({ finished: 1, failed: 1 })
  })
})
