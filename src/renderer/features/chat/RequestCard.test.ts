// The repo has no DOM, so the card renders to a string; the form card is stubbed to see which request reaches it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { PendingRequest } from '../../../shared/model'
import { RequestCard } from './RequestCard'

// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({ notify: vi.fn(), useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} }) }))
vi.mock('./askForm/FormRequestCard', () => ({
  FormRequestCard: ({ sessionId, request }: { sessionId: string; request: { requestId: string } }) => `form-card:${sessionId}:${request.requestId}`
}))

const render = (request: PendingRequest): string => renderToStaticMarkup(createElement(RequestCard, { sessionId: 's1', request }))

describe('RequestCard', () => {
  test("Given a request of kind 'form', When the card renders, Then the form card gets it and no approval or question chrome shows", () => {
    const html = render({ kind: 'form', requestId: 'r9', html: '<form></form>', deadlineAt: 0 } as PendingRequest)
    expect(html).toBe('form-card:s1:r9')
  })
})
