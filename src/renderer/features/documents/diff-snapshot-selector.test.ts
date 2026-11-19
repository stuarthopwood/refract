import { describe, expect, it } from 'vitest'
import { gitSnapshot } from './documents-test-fixtures'
import { snapshotForDiffTabs } from './diff-snapshot-selector'

const loaded = gitSnapshot({})
const bySession = { s1: { snapshot: loaded }, s2: { snapshot: null } }

describe('snapshotForDiffTabs', () => {
  it('gives the Session snapshot while a diff tab is open', () => {
    expect(snapshotForDiffTabs(bySession, 's1', true)).toBe(loaded)
  })

  it('gives null without a diff tab, so git watch events do not re-render the shell', () => {
    expect(snapshotForDiffTabs(bySession, 's1', false)).toBeNull()
  })

  it('gives null with no Session or no loaded snapshot', () => {
    expect(snapshotForDiffTabs(bySession, null, true)).toBeNull()
    expect(snapshotForDiffTabs(bySession, 's2', true)).toBeNull()
    expect(snapshotForDiffTabs(bySession, 'missing', true)).toBeNull()
  })
})
