import { describe, expect, test } from 'vitest'
import { pullRequestBadgeStatus } from './pullRequestBadgeStatus'

describe('pullRequestBadgeStatus', () => {
  test('Given an open PR with passing checks, Then the spoken state carries the checks', () => {
    expect(pullRequestBadgeStatus('open', 'pass')).toBe('open, checks passed')
  })

  test('Given a merged PR with no checks readout, Then only the state is spoken', () => {
    expect(pullRequestBadgeStatus('merged', null)).toBe('merged')
  })

  test('Given a draft PR with running checks, Then both are spoken', () => {
    expect(pullRequestBadgeStatus('draft', 'pending')).toBe('draft, checks running')
  })
})
