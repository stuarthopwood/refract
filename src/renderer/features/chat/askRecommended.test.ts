import { describe, expect, it } from 'vitest'
import type { AskQuestion } from '../../../shared/model'
import { EMPTY_ASK_QUESTION_DRAFT } from '@/state/ask-picks-store'
import { draftAfterUseRecommended, initialPickFor, recommendedIndex, recommendedLabel, shouldTakeInitialFocus } from './askRecommended'

function question(overrides: Partial<AskQuestion> = {}): AskQuestion {
  return { id: 'q1', question: 'Which?', options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }], multi: false, ...overrides }
}

describe('recommendedIndex / recommendedLabel', () => {
  it('returns the index and label of an in-range recommendation', () => {
    expect(recommendedIndex(question({ recommended: 1 }))).toBe(1)
    expect(recommendedLabel(question({ recommended: 1 }))).toBe('Beta')
  })

  it('accepts index 0', () => {
    expect(recommendedIndex(question({ recommended: 0 }))).toBe(0)
  })

  it.each([undefined, -1, 3, 99])('treats %s as no recommendation', (recommended) => {
    const q = question({ recommended })
    expect(recommendedIndex(q)).toBeUndefined()
    expect(recommendedLabel(q)).toBeUndefined()
  })
})

describe('initialPickFor', () => {
  it('preselects the recommended label of a single-choice question', () => {
    expect(initialPickFor(question({ recommended: 2 }))).toBe('Gamma')
  })

  it('never ticks a multiple-choice question for the user', () => {
    expect(initialPickFor(question({ recommended: 2, multi: true }))).toBeUndefined()
  })

  it('preselects nothing without a recommendation', () => {
    expect(initialPickFor(question())).toBeUndefined()
  })
})

describe('draftAfterUseRecommended', () => {
  it('picks the recommended option on a single choice and drops Other', () => {
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: [], otherSelected: true, customInput: 'mine' }
    expect(draftAfterUseRecommended(question({ recommended: 1 }), draft)).toEqual({ ...draft, selectedOptions: ['Beta'], otherSelected: false })
  })

  it('replaces a different single-choice pick', () => {
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: ['Alpha'] }
    expect(draftAfterUseRecommended(question({ recommended: 2 }), draft)?.selectedOptions).toEqual(['Gamma'])
  })

  it('ticks the recommended option on a multiple choice, keeping other ticks and Other', () => {
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: ['Alpha'], otherTicked: true, customInput: 'x' }
    expect(draftAfterUseRecommended(question({ recommended: 1, multi: true }), draft)).toEqual({ ...draft, selectedOptions: ['Alpha', 'Beta'] })
  })

  it('does not untick an already-ticked recommended option on a multiple choice', () => {
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: ['Beta'] }
    expect(draftAfterUseRecommended(question({ recommended: 1, multi: true }), draft)).toBe(draft)
  })

  it('returns nothing when there is no recommendation', () => {
    expect(draftAfterUseRecommended(question(), EMPTY_ASK_QUESTION_DRAFT)).toBeUndefined()
  })
})

describe('shouldTakeInitialFocus', () => {
  it('takes focus when nothing, or a non-text element, has it', () => {
    expect(shouldTakeInitialFocus(null)).toBe(true)
    expect(shouldTakeInitialFocus({ tagName: 'BODY' })).toBe(true)
  })

  it('leaves a composer with text in it alone', () => {
    expect(shouldTakeInitialFocus({ tagName: 'TEXTAREA', value: 'half a sen' })).toBe(false)
    expect(shouldTakeInitialFocus({ tagName: 'input', value: 'x' })).toBe(false)
    expect(shouldTakeInitialFocus({ tagName: 'DIV', isContentEditable: true, textContent: 'typing' })).toBe(false)
  })

  it('takes focus from an empty or whitespace-only field', () => {
    expect(shouldTakeInitialFocus({ tagName: 'TEXTAREA', value: '' })).toBe(true)
    expect(shouldTakeInitialFocus({ tagName: 'TEXTAREA', value: '  ' })).toBe(true)
    expect(shouldTakeInitialFocus({ tagName: 'DIV', isContentEditable: true, textContent: ' ' })).toBe(true)
  })
})
