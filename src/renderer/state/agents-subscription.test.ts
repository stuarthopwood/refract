import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsGroup, AgentsUpdatePayload, Result } from '../../shared/ipc'
import { initAgentsSubscription } from './agents-subscription'
import { EMPTY_AGENT_GROUPS, useAgentsStore } from './agents-store'

const group = (sessionId: string): AgentsGroup => ({ sessionId, name: sessionId, status: 'working', subagents: [] })

let push: (payload: AgentsUpdatePayload) => void = () => {}
type Snapshot = Result<AgentsUpdatePayload>
// The web tsconfig lib predates `Promise.withResolvers`, so the deferred is built by hand.
const deferSnapshot = () => {
  let resolve: (result: Snapshot) => void = () => {}
  const promise = new Promise<Snapshot>((done) => (resolve = done))
  return { promise, resolve }
}
let pendingSnapshot = deferSnapshot()
let dispose: () => void = () => {}
const order: string[] = []

const stubRefract = (snapshot: () => Promise<Result<AgentsUpdatePayload>>) => {
  vi.stubGlobal('window', {
    refract: {
      onAgentsUpdate: (handler: (payload: AgentsUpdatePayload) => void) => {
        order.push('subscribe')
        push = handler
        return () => {}
      },
      agents: {
        snapshot: () => {
          order.push('pull')
          return snapshot()
        }
      }
    }
  })
}

// The pull is a resolved promise chain, so a few microtask turns drain it without a real timer.
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve()
}

beforeEach(() => {
  order.length = 0
  useAgentsStore.setState({ groups: EMPTY_AGENT_GROUPS })
  pendingSnapshot = deferSnapshot()
  stubRefract(() => pendingSnapshot.promise)
})

afterEach(() => dispose())

describe('initAgentsSubscription', () => {
  it('subscribes_before_pulling_so_nothing_lands_in_the_gap', () => {
    dispose = initAgentsSubscription()
    expect(order).toEqual(['subscribe', 'pull'])
  })

  it('applies_the_pulled_aggregate_when_no_push_has_landed', async () => {
    dispose = initAgentsSubscription()
    pendingSnapshot.resolve({ ok: true, value: { groups: [group('s1')] } })
    await settle()
    expect(useAgentsStore.getState().groups.map((g) => g.sessionId)).toEqual(['s1'])
  })

  it('keeps_a_push_that_beat_the_pulled_aggregate', async () => {
    dispose = initAgentsSubscription()
    push({ groups: [group('fresh')] })
    pendingSnapshot.resolve({ ok: true, value: { groups: [group('stale')] } })
    await settle()
    expect(useAgentsStore.getState().groups.map((g) => g.sessionId)).toEqual(['fresh'])
  })

  it('applies_a_push_after_the_pulled_aggregate', async () => {
    dispose = initAgentsSubscription()
    pendingSnapshot.resolve({ ok: true, value: { groups: [group('s1')] } })
    await settle()
    push({ groups: [] })
    expect(useAgentsStore.getState().groups).toEqual([])
  })

  it('leaves_the_store_empty_when_the_pull_fails', async () => {
    stubRefract(() => Promise.reject(new Error('handler not registered')))
    dispose = initAgentsSubscription()
    await settle()
    expect(useAgentsStore.getState().groups).toEqual([])
    push({ groups: [group('s2')] })
    expect(useAgentsStore.getState().groups).toHaveLength(1)
  })
})
