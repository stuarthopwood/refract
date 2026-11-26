import { describe, expect, it } from 'vitest'
import { cleanTitle } from './cleanTitle'

describe('cleanTitle', () => {
  describe('given a synthesised overall goal', () => {
    it('prefers it over the context and the names', () => {
      expect(cleanTitle({ overallGoal: ' Audit the login flow ', context: 'Goal: something else', names: ['A', 'B'] })).toBe('Audit the login flow')
    })
  })

  describe('given a context that opens with a worktree path', () => {
    it('drops the path and the bare "Repo" label it leaves, then uses the next line', () => {
      const context = 'Repo C:\\Users\\me\\worktrees\\daring-plover\nGoal: Audit the login flow'
      expect(cleanTitle({ context, names: ['A', 'B'] })).toBe('Audit the login flow')
    })

    it('strips a posix worktree path from the middle of a line', () => {
      expect(cleanTitle({ context: 'Review /home/me/worktrees/x/src now', names: [] })).toBe('Review now')
    })
  })

  describe('given Rules (HARD) boilerplate', () => {
    it('stops at the boilerplate and falls back to the shared name prefix', () => {
      expect(cleanTitle({ context: '## Rules (HARD)\n- never push', names: ['GateA', 'GateB'] })).toBe('Gate')
    })

    it('keeps a useful first line that precedes the boilerplate', () => {
      expect(cleanTitle({ context: 'Fix the flaky test\n\nRules (HARD)\n- x', names: ['A'] })).toBe('Fix the flaky test')
    })
  })

  describe('given neither goal nor context', () => {
    it('uses a single agent name, and null when nothing is shared', () => {
      expect(cleanTitle({ names: ['Solo'] })).toBe('Solo')
      expect(cleanTitle({ names: ['Alpha', 'Zed'] })).toBeNull()
    })
  })
})
