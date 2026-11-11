import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { pausedNoticeAnnouncement } from './pausedNotices'

const notice = (id: string, text: string): TranscriptItem => ({ kind: 'notice', id, level: 'info', text })

describe('pausedNoticeAnnouncement', () => {
  it('shortens an auto-cancel notice', () => {
    const items = [notice('a', 'Pause cancelled subagent late-1, which started while this Session was paused.')]
    expect(pausedNoticeAnnouncement(items, new Set()).text).toBe('Pause cancelled subagent late-1 (started while paused).')
  })

  it('keeps the Resume count and drops the guidance', () => {
    const items = [
      notice('b', 'Resumed. Pause had cancelled 2 subagents: a, b. They are not restarted; ask the agent to run them again if you still need them.')
    ]
    expect(pausedNoticeAnnouncement(items, new Set()).text).toBe('Resumed. Pause had cancelled 2 subagents: a, b. They are not restarted.')
  })

  it('skips seen and unrelated notices', () => {
    const items = [notice('a', 'Pause cancelled 1 subagent: x.'), notice('c', 'Something else'), notice('d', 'Pause could not cancel 1 subagent: y (boom).')]
    const result = pausedNoticeAnnouncement(items, new Set(['a']))
    expect(result).toEqual({ text: 'Pause could not cancel 1 subagent: y (boom).', ids: ['d'] })
  })

  it('is empty when nothing is new', () => {
    expect(pausedNoticeAnnouncement([], new Set())).toEqual({ text: '', ids: [] })
  })
})
