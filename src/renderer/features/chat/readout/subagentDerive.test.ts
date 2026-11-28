import { describe, expect, it } from 'vitest'
import { deriveSubagentPhrase, deriveSubagentSettledPhrase, isSubagentFailurePhrase, type SubagentCount } from './subagentDerive'

const counts = (overrides: Partial<SubagentCount> = {}): SubagentCount => ({ running: 0, finished: 0, exited: 0, failed: 0, cancelled: 0, ...overrides })

describe('deriveSubagentPhrase', () => {
  it('says only how many are running while any agent runs, whatever else settled', () => {
    expect(deriveSubagentPhrase(counts({ running: 2 }))).toBe('2 running')
    expect(deriveSubagentPhrase(counts({ running: 1, finished: 3, failed: 1, exited: 1, cancelled: 1 }))).toBe('1 running')
  })

  it('shows the failures of a settled Stage so one is never silent', () => {
    expect(deriveSubagentPhrase(counts({ failed: 1 }))).toBe('1 failed')
    expect(deriveSubagentPhrase(counts({ exited: 2 }))).toBe('2 exited')
    expect(deriveSubagentPhrase(counts({ failed: 2, exited: 1 }))).toBe('2 failed, 1 exited')
  })

  it('never says finished or names a cancelled agent next to a failure', () => {
    expect(deriveSubagentPhrase(counts({ finished: 4, failed: 1, cancelled: 2 }))).toBe('1 failed')
  })

  it('is empty, so the pill hides, when nothing runs and nothing failed', () => {
    expect(deriveSubagentPhrase(counts())).toBe('')
    expect(deriveSubagentPhrase(counts({ finished: 5 }))).toBe('')
    expect(deriveSubagentPhrase(counts({ cancelled: 2 }))).toBe('')
    expect(deriveSubagentPhrase(counts({ finished: 1, cancelled: 1 }))).toBe('')
  })
})

describe('isSubagentFailurePhrase', () => {
  it('is true only when nothing runs and an agent failed or exited', () => {
    expect(isSubagentFailurePhrase(counts({ failed: 1 }))).toBe(true)
    expect(isSubagentFailurePhrase(counts({ exited: 1 }))).toBe(true)
  })

  it('is false while an agent runs, so the running pill carries no failure icon', () => {
    expect(isSubagentFailurePhrase(counts({ running: 1, failed: 1 }))).toBe(false)
  })

  it('is false for a pill that is empty or shows nothing failed', () => {
    expect(isSubagentFailurePhrase(counts())).toBe(false)
    expect(isSubagentFailurePhrase(counts({ finished: 2, cancelled: 1 }))).toBe(false)
  })

  it('agrees with the phrase: a failure is flagged exactly when the phrase names failed or exited', () => {
    for (const c of [counts({ failed: 1 }), counts({ exited: 1 }), counts({ running: 1, failed: 1 }), counts({ finished: 1 }), counts()]) {
      expect(isSubagentFailurePhrase(c)).toBe(/failed|exited/.test(deriveSubagentPhrase(c)))
    }
  })
})

describe('deriveSubagentSettledPhrase', () => {
  it('keeps finished, exited, failed and cancelled apart in that order', () => {
    expect(deriveSubagentSettledPhrase(counts({ finished: 2, exited: 1, failed: 1, cancelled: 1 }))).toBe('2 finished, 1 exited, 1 failed, 1 cancelled')
  })

  it('reads "1 failed", never "0 finished", for a turn whose only agent failed', () => {
    expect(deriveSubagentSettledPhrase(counts({ failed: 1 }))).toBe('1 failed')
  })

  it('ignores running agents and is empty when nothing settled', () => {
    expect(deriveSubagentSettledPhrase(counts({ running: 3 }))).toBe('')
  })
})
