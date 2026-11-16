import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_ASK_QUESTION_DRAFT, useAskPicksStore } from './ask-picks-store'

const read = () => useAskPicksStore.getState().bySession.s1?.r1?.byQuestionId.q1

beforeEach(() => useAskPicksStore.setState({ bySession: {} }))

describe('setActiveQuestion preselect (#1985)', () => {
  it('preselects on the first open and marks the question viewed and active', () => {
    useAskPicksStore.getState().setActiveQuestion('s1', 'r1', 'q1', 'Beta')
    expect(read()).toMatchObject({ selectedOptions: ['Beta'], viewed: true })
    expect(useAskPicksStore.getState().bySession.s1?.r1?.activeQuestionId).toBe('q1')
  })

  it('never overrides a pick the user already made', () => {
    useAskPicksStore.getState().selectSingleOption('s1', 'r1', 'q1', 'Alpha')
    useAskPicksStore.getState().setActiveQuestion('s1', 'r1', 'q1', 'Beta')
    expect(read()?.selectedOptions).toEqual(['Alpha'])
  })

  it('never overrides Other', () => {
    useAskPicksStore.getState().selectOther('s1', 'r1', 'q1')
    useAskPicksStore.getState().setActiveQuestion('s1', 'r1', 'q1', 'Beta')
    expect(read()).toMatchObject({ selectedOptions: [], otherSelected: true })
  })

  it('does not preselect again when the tab is reopened after the user cleared it', () => {
    useAskPicksStore.getState().setActiveQuestion('s1', 'r1', 'q1', 'Beta')
    useAskPicksStore.getState().replaceQuestionDraft('s1', 'r1', 'q1', { ...EMPTY_ASK_QUESTION_DRAFT, viewed: true })
    useAskPicksStore.getState().setActiveQuestion('s1', 'r1', 'q1', 'Beta')
    expect(read()?.selectedOptions).toEqual([])
  })
})

describe('replaceQuestionDraft', () => {
  it('replaces the whole draft of one question and leaves the others alone', () => {
    useAskPicksStore.getState().selectSingleOption('s1', 'r1', 'q2', 'Z')
    useAskPicksStore.getState().replaceQuestionDraft('s1', 'r1', 'q1', { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: ['Beta'], customInput: 'kept' })
    expect(read()).toMatchObject({ selectedOptions: ['Beta'], customInput: 'kept' })
    expect(useAskPicksStore.getState().bySession.s1?.r1?.byQuestionId.q2?.selectedOptions).toEqual(['Z'])
  })
})
