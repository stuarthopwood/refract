import { describe, expect, it } from 'vitest'
import type { AskQuestion } from '../../../shared/model'
import { EMPTY_ASK_QUESTION_DRAFT } from '@/state/ask-picks-store'
import { draftAfterUseRecommended, initialPickFor, opensOnRecommended, recommendedFlags, recommendedLabels, shouldTakeInitialFocus } from './askRecommended'

function question(overrides: Partial<AskQuestion> = {}): AskQuestion {
  return { id: 'q1', question: 'Which?', options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }], multi: false, ...overrides }
}

describe('recommendedFlags / recommendedLabels', () => {
  it('reads the question-level index of an old transcript or a native ask', () => {
    expect(recommendedFlags(question({ recommended: 1 }))).toEqual([false, true, false])
    expect(recommendedLabels(question({ recommended: 1 }))).toEqual(['Beta'])
  })

  it('accepts index 0', () => {
    expect(recommendedLabels(question({ recommended: 0 }))).toEqual(['Alpha'])
  })

  it.each([undefined, -1, 3, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('treats %s as no recommendation', (recommended) => {
    const q = question({ recommended })
    expect(recommendedFlags(q)).toEqual([false, false, false])
    expect(recommendedLabels(q)).toEqual([])
  })

  it('reads per-option flags, several of them', () => {
    const q = question({ options: [{ label: 'Alpha', recommended: true }, { label: 'Beta' }, { label: 'Gamma', recommended: true }] })
    expect(recommendedFlags(q)).toEqual([true, false, true])
    expect(recommendedLabels(q)).toEqual(['Alpha', 'Gamma'])
  })

  it('lets per-option flags win over a question-level index', () => {
    const q = question({ recommended: 0, options: [{ label: 'Alpha' }, { label: 'Beta', recommended: true }, { label: 'Gamma' }] })
    expect(recommendedLabels(q)).toEqual(['Beta'])
  })
})

describe('initialPickFor', () => {
  it('preselects the recommended label of a single-choice question', () => {
    expect(initialPickFor(question({ recommended: 2 }))).toBe('Gamma')
    expect(initialPickFor(question({ options: [{ label: 'Alpha' }, { label: 'Beta', recommended: true }] }))).toBe('Beta')
  })

  it('never ticks a multiple-choice question for the user, however many are recommended', () => {
    expect(initialPickFor(question({ recommended: 2, multi: true }))).toBeUndefined()
    expect(initialPickFor(question({ multi: true, options: [{ label: 'Alpha', recommended: true }, { label: 'Beta', recommended: true }] }))).toBeUndefined()
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

  it('ticks every recommended option on a multiple choice, keeping earlier ticks', () => {
    const q = question({ multi: true, options: [{ label: 'Alpha', recommended: true }, { label: 'Beta' }, { label: 'Gamma', recommended: true }] })
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: ['Beta', 'Gamma'] }
    expect(draftAfterUseRecommended(q, EMPTY_ASK_QUESTION_DRAFT)?.selectedOptions).toEqual(['Alpha', 'Gamma'])
    expect(draftAfterUseRecommended(q, draft)?.selectedOptions).toEqual(['Beta', 'Gamma', 'Alpha'])
  })
})

describe('opensOnRecommended', () => {
  it('is true only for a single-choice question with a valid recommendation', () => {
    expect(opensOnRecommended(question({ recommended: 1 }))).toBe(true)
    expect(opensOnRecommended(question({ options: [{ label: 'Alpha', recommended: true }] }))).toBe(true)
    expect(opensOnRecommended(question({ recommended: 1, multi: true }))).toBe(false)
    expect(opensOnRecommended(question({ multi: true, options: [{ label: 'Alpha', recommended: true }, { label: 'Beta', recommended: true }] }))).toBe(false)
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
