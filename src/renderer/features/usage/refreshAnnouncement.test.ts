// Issue #1849: the refresh overlay card is aria-hidden, so the polite status carries the start and end of a refresh.
import { describe, expect, it } from 'vitest'
import { refreshAnnouncement } from './refreshAnnouncement'

describe('refreshAnnouncement', () => {
  it('announces_updating_when_a_refresh_starts', () => {
    expect(refreshAnnouncement(false, true)).toBe('Updating usage')
  })

  it('announces_updated_when_a_refresh_ends', () => {
    expect(refreshAnnouncement(true, false)).toBe('Usage updated')
  })

  it('stays_silent_while_nothing_changes', () => {
    expect(refreshAnnouncement(false, false)).toBeNull()
    expect(refreshAnnouncement(true, true)).toBeNull()
  })
})
