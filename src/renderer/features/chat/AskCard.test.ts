// The repo has no jsdom: the card is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AskQuestion, PendingRequest } from '../../../shared/model'
import { EMPTY_ASK_QUESTION_DRAFT } from '@/state/ask-picks-store'
import { AskCard, buildAnswers, formatDeadlineText, runUnlessBusy } from './AskCard'

// The markdown renderer and the state barrel need a browser `window` at import; neither is under test.
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }))
vi.mock('@/state', () => ({ notify: vi.fn() }))

type AskRequest = Extract<PendingRequest, { kind: 'ask' }>

function question(overrides: Partial<AskQuestion> = {}): AskQuestion {
  return { id: 'q1', question: 'Which checks?', multi: true, options: [{ label: 'Lint, fast', recommended: true }, { label: 'Tests', recommended: true }, { label: 'Docs' }], ...overrides }
}

function render(q: AskQuestion): string {
  const request = { kind: 'ask', requestId: 'r1', questions: [q] } as AskRequest
  return renderToStaticMarkup(createElement(AskCard, { sessionId: 's1', request }))
}

describe('AskCard Use Recommended (#1985 rest)', () => {
  it('names every recommended option in the accessible name, joined with "; " so a label with a comma stays one name', () => {
    expect(render(question())).toContain('aria-label="Use recommended: Lint, fast; Tests"')
  })

  it('shows no Use Recommended button when nothing is recommended', () => {
    expect(render(question({ options: [{ label: 'Lint' }, { label: 'Tests' }] }))).not.toContain('Use Recommended')
  })
})

describe('formatDeadlineText', () => {
  const DEADLINE = Date.UTC(2026, 10, 23, 9, 30)

  it('says the recommended answers are used when options carry per-option flags', () => {
    expect(formatDeadlineText(DEADLINE, [question()])).toContain('the agent uses the recommended answers.')
  })

  it('says the first option is used when nothing is recommended', () => {
    expect(formatDeadlineText(DEADLINE, [question({ options: [{ label: 'Lint' }, { label: 'Tests' }] })])).toContain('the agent uses the first option for each question.')
  })
})

describe('AskCard option notes (#1987)', () => {
  function renderHost(q: AskQuestion, hostCall: boolean): string {
    const request = { kind: 'ask', requestId: 'r1', questions: [q], hostCall } as AskRequest
    return renderToStaticMarkup(createElement(AskCard, { sessionId: 's1', request }))
  }

  it('shows the "Press N" hint on a refract_ask card only', () => {
    expect(renderHost(question(), true)).toContain('to add a note to selected option')
    expect(renderHost(question(), false)).not.toContain('to add a note to selected option')
  })
})

describe('buildAnswers notes (#1987)', () => {
  const multi = question({ options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] })
  const single = question({ id: 'q2', multi: false, options: [{ label: 'A' }, { label: 'B' }] })

  it('sends only the notes on picked options of a multi-select', () => {
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: ['A', 'B'], notes: { A: 'one', B: 'two', C: 'hidden' } }
    expect(buildAnswers([multi], { q1: draft }, true)).toEqual([
      { id: 'q1', selectedOptions: ['A', 'B'], notes: [{ option: 'A', text: 'one' }, { option: 'B', text: 'two' }] }
    ])
  })

  it('sends the note on a single-choice pick, and drops a note left on the option no longer picked', () => {
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: ['B'], notes: { A: 'old', B: 'why' } }
    expect(buildAnswers([single], { q2: draft }, true)).toEqual([{ id: 'q2', selectedOptions: ['B'], notes: [{ option: 'B', text: 'why' }] }])
  })

  it('never puts a note on a typed Other answer', () => {
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, otherSelected: true, customInput: 'mine', notes: { A: 'hidden' } }
    expect(buildAnswers([single], { q2: draft }, true)).toEqual([{ id: 'q2', selectedOptions: [], customInput: 'mine' }])
  })

  it('sends no notes field when there are none, or when the card is not a refract_ask card', () => {
    const draft = { ...EMPTY_ASK_QUESTION_DRAFT, selectedOptions: ['A'], notes: { A: 'x' } }
    expect(buildAnswers([multi], { q1: draft }, false)).toEqual([{ id: 'q1', selectedOptions: ['A'] }])
    expect(buildAnswers([multi], { q1: { ...draft, notes: {} } }, true)).toEqual([{ id: 'q1', selectedOptions: ['A'] }])
  })
})

describe('runUnlessBusy', () => {
  it('does not run the action while a send or cancel is in flight, so a busy card cannot resubmit', () => {
    const submit = vi.fn()
    runUnlessBusy(true, submit)
    expect(submit).not.toHaveBeenCalled()
  })

  it('runs the action once the card is idle', () => {
    const submit = vi.fn()
    runUnlessBusy(false, submit)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
