import { describe, expect, it } from 'vitest'
import { deriveActivity, type ActivityInput } from './activity'

const idle: ActivityInput = { needsYou: false, runningSubagents: 0, todo: null }

describe('deriveActivity intent line (FR-140)', () => {
  it('shows the brief label of the latest intent, not the full intent', () => {
    const activity = deriveActivity({ ...idle, latestIntent: 'Reading config: to find the port the server binds' })
    expect(activity).toEqual({ kind: 'intent', text: 'Reading config' })
  })

  it('shows an intent with no qualifying colon in full', () => {
    const activity = deriveActivity({ ...idle, latestIntent: 'Fetching http://localhost:3000/health' })
    expect(activity).toEqual({ kind: 'intent', text: 'Fetching http://localhost:3000/health' })
  })

  it('strips control characters before taking the label', () => {
    const activity = deriveActivity({ ...idle, latestIntent: 'Run\u202e tests:\u0007 all of them' })
    expect(activity).toEqual({ kind: 'intent', text: 'Run tests' })
  })

  it('still falls back to the tool phrase when the intent is empty', () => {
    const activity = deriveActivity({ ...idle, latestIntent: '  ', latestTool: { name: 'bash', target: null } })
    expect(activity).toEqual({ kind: 'tool', text: 'Running a command' })
  })
})
