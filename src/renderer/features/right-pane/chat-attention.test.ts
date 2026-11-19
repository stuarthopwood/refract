import { describe, expect, it, vi } from 'vitest'

// sessionDisplay.tsx (home of `isNeedsYouSession`) imports the store barrel, whose dev hook needs `window`.
vi.mock('@/state', () => ({ useSettingsStore: () => undefined }))
import type { SessionSummary } from '../../../shared/ipc'
import { chatAttentionAnnouncement, chatBadgeCount, chatToggleLabel, needsYouInPanes } from './chat-attention'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, status: 'idle', archivedAt: null, hiddenAt: null, ...over } as SessionSummary
}

describe('needsYouInPanes', () => {
  it('Given a Split with one waiting Session and one elsewhere, When counting, Then only the visible waiting Session counts', () => {
    const sessions = [session('a', { status: 'needs-you' }), session('b'), session('c', { status: 'needs-you' })]
    expect(needsYouInPanes(['a', 'b'], sessions)).toBe(1)
  })

  it('Given both Split panes waiting, When counting, Then the count is 2', () => {
    const sessions = [session('a', { status: 'needs-you' }), session('b', { status: 'needs-you' })]
    expect(needsYouInPanes(['a', 'b'], sessions)).toBe(2)
  })

  it('Given a waiting Session that is archived or hidden, When counting, Then it is not counted', () => {
    const sessions = [session('a', { status: 'needs-you', archivedAt: '2026-11-19' }), session('b', { status: 'needs-you', hiddenAt: '2026-11-19' })]
    expect(needsYouInPanes(['a', 'b'], sessions)).toBe(0)
  })

  it('Given no Chat panes, When counting, Then the count is 0', () => {
    expect(needsYouInPanes([], [session('a', { status: 'needs-you' })])).toBe(0)
  })
})

describe('chatBadgeCount', () => {
  it('shows the count only while chat is hidden', () => {
    expect(chatBadgeCount({ hidden: true, needsYou: 2 })).toBe(2)
    expect(chatBadgeCount({ hidden: false, needsYou: 2 })).toBe(0)
  })
})

describe('chatToggleLabel', () => {
  it('keeps the base name with no badge', () => {
    expect(chatToggleLabel(0)).toBe('Chat pane')
  })

  it('appends the needs-you wording, singular and plural', () => {
    expect(chatToggleLabel(1)).toBe('Chat pane, 1 needs you')
    expect(chatToggleLabel(2)).toBe('Chat pane, 2 need you')
  })
})

describe('chatAttentionAnnouncement', () => {
  it('announces once when attention rises while chat stays hidden', () => {
    expect(chatAttentionAnnouncement({ hidden: true, needsYou: 0 }, { hidden: true, needsYou: 1 })).toBe('Chat pane, 1 needs you')
  })

  it('stays silent when chat is hidden or shown, since that action announces itself', () => {
    expect(chatAttentionAnnouncement({ hidden: false, needsYou: 0 }, { hidden: true, needsYou: 1 })).toBeNull()
    expect(chatAttentionAnnouncement({ hidden: true, needsYou: 1 }, { hidden: false, needsYou: 1 })).toBeNull()
  })

  it('stays silent when the status clears or does not change', () => {
    expect(chatAttentionAnnouncement({ hidden: true, needsYou: 1 }, { hidden: true, needsYou: 0 })).toBeNull()
    expect(chatAttentionAnnouncement({ hidden: true, needsYou: 1 }, { hidden: true, needsYou: 1 })).toBeNull()
  })
})
