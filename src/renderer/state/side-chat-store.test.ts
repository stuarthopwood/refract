// #2075 FR-028: the Side chat draft lives in the store so a tab switch (panel unmount) keeps the unsent question.
import { beforeEach, describe, expect, it } from 'vitest'
import { useSideChatStore } from './side-chat-store'

beforeEach(() => useSideChatStore.setState({ bySession: {}, draftBySession: {} }))

describe('useSideChatStore draft', () => {
  it('keeps the unsent question when the thread is cleared on a Conversation change', () => {
    useSideChatStore.getState().setDraft('s1', 'why?')
    useSideChatStore.getState().clearThread('s1')
    expect(useSideChatStore.getState().draftBySession.s1).toBe('why?')
  })

  it('keeps each Session draft apart', () => {
    useSideChatStore.getState().setDraft('s1', 'one')
    useSideChatStore.getState().setDraft('s2', 'two')
    expect(useSideChatStore.getState().draftBySession).toEqual({ s1: 'one', s2: 'two' })
  })

  it('drops the entry when the draft is cleared to empty', () => {
    useSideChatStore.getState().setDraft('s1', 'one')
    useSideChatStore.getState().setDraft('s1', '')
    expect(useSideChatStore.getState().draftBySession).toEqual({})
  })

  it('prunes drafts of Sessions not kept, and returns the same state when nothing goes', () => {
    useSideChatStore.getState().setDraft('keep', 'a')
    useSideChatStore.getState().setDraft('gone', 'b')
    useSideChatStore.getState().pruneDrafts(new Set(['keep']))
    expect(useSideChatStore.getState().draftBySession).toEqual({ keep: 'a' })
    const before = useSideChatStore.getState()
    before.pruneDrafts(new Set(['keep']))
    expect(useSideChatStore.getState()).toBe(before)
  })
})
