// The repo has no jsdom: the card is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AskQuestion, PendingRequest } from '../../../shared/model'
import { AskCard, formatDeadlineText } from './AskCard'

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
