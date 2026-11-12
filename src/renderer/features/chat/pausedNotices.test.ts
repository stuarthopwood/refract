import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { pausedNoticeAnnouncement } from './pausedNotices'

const notice = (id: string, text: string): TranscriptItem => ({ kind: 'notice', id, level: 'info', text })

describe('pausedNoticeAnnouncement', () => {
  it('shortens an auto-cancel notice', () => {
    const items = [notice('a', 'Pause cancelled subagent late-1, which started while this Session was paused.')]
    expect(pausedNoticeAnnouncement(items, new Set()).text).toBe('Pause cancelled subagent late-1 (started while paused).')
  })

  it('keeps the Resume count, drops the guidance and the "Resumed." prefix', () => {
    const items = [
      notice('b', 'Resumed. Pause had cancelled 2 subagents: a, b. They are not restarted; ask the agent to run them again if you still need them.')
    ]
    expect(pausedNoticeAnnouncement(items, new Set()).text).toBe('Pause had cancelled 2 subagents: a, b. They are not restarted.')
  })

  it('announces a failed listing', () => {
    const items = [notice('e', 'Pause could not list the running subagents: boom')]
    expect(pausedNoticeAnnouncement(items, new Set())).toEqual({ text: 'Pause could not list the running subagents: boom', ids: ['e'] })
  })

  it('announces a failed auto-cancel and shortens it', () => {
    const items = [notice('f', 'Pause could not cancel subagent late-1, which started while this Session was paused: boom')]
    expect(pausedNoticeAnnouncement(items, new Set())).toEqual({
      text: 'Pause could not cancel subagent late-1 (started while paused): boom',
      ids: ['f']
    })
  })

  it('announces an auto-cancel that raced Resume', () => {
    const items = [notice('g', 'Pause cancelled subagent late-1, which started as this Session was resumed. It is not restarted.')]
    expect(pausedNoticeAnnouncement(items, new Set()).ids).toEqual(['g'])
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
