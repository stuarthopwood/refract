import { describe, expect, it } from 'vitest'
import type { AskQuestion } from '../../../shared/model'
import { EMPTY_ASK_QUESTION_DRAFT } from '@/state/ask-picks-store'
import { draftAfterUseRecommended, initialPickFor, opensOnRecommended, recommendedIndex, recommendedLabel, shouldTakeInitialFocus } from './askRecommended'

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

  it.each([undefined, -1, 3, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('treats %s as no recommendation', (recommended) => {
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

describe('opensOnRecommended', () => {
  it('is true only for a single-choice question with a valid recommendation', () => {
    expect(opensOnRecommended(question({ recommended: 1 }))).toBe(true)
    expect(opensOnRecommended(question({ recommended: 1, multi: true }))).toBe(false)
    expect(opensOnRecommended(question())).toBe(false)
    expect(opensOnRecommended(question({ recommended: 9 }))).toBe(false)
  })
})

describe('shouldTakeInitialFocus', () => {
  it('takes focus when nothing, or body, has it', () => {
    expect(shouldTakeInitialFocus(null)).toBe(true)
    expect(shouldTakeInitialFocus({ tagName: 'BODY' })).toBe(true)
    expect(shouldTakeInitialFocus({ tagName: 'BODY', inOverlay: true })).toBe(true)
  })

  it('takes focus from a non-text element in its own Session pane', () => {
    expect(shouldTakeInitialFocus({ tagName: 'BUTTON', inOwnSessionPane: true })).toBe(true)
  })

  it('never takes focus from another pane', () => {
    expect(shouldTakeInitialFocus({ tagName: 'BUTTON', inOwnSessionPane: false })).toBe(false)
    expect(shouldTakeInitialFocus({ tagName: 'TEXTAREA', value: '', inOwnSessionPane: false })).toBe(false)
    expect(shouldTakeInitialFocus({ tagName: 'DIV' })).toBe(false)
  })

  it('never takes focus from inside a menu, dialog or listbox, even in its own pane', () => {
    expect(shouldTakeInitialFocus({ tagName: 'DIV', inOwnSessionPane: true, inOverlay: true })).toBe(false)
  })

  it('leaves a composer with text in it alone', () => {
    expect(shouldTakeInitialFocus({ tagName: 'TEXTAREA', value: 'half a sen', inOwnSessionPane: true })).toBe(false)
    expect(shouldTakeInitialFocus({ tagName: 'input', value: 'x', inOwnSessionPane: true })).toBe(false)
    expect(shouldTakeInitialFocus({ tagName: 'DIV', isContentEditable: true, textContent: 'typing', inOwnSessionPane: true })).toBe(false)
  })

  it('takes focus from an empty or whitespace-only field in its own pane', () => {
    expect(shouldTakeInitialFocus({ tagName: 'TEXTAREA', value: '', inOwnSessionPane: true })).toBe(true)
    expect(shouldTakeInitialFocus({ tagName: 'TEXTAREA', value: '  ', inOwnSessionPane: true })).toBe(true)
    expect(shouldTakeInitialFocus({ tagName: 'DIV', isContentEditable: true, textContent: ' ', inOwnSessionPane: true })).toBe(true)
  })
})
