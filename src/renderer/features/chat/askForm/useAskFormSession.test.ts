// The repo has no DOM, so the hook's effect cannot run; this drives the same calls it chains:
// nextAction -> sendAnswer -> afterSendFailed.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { REQUEST_GONE_CANCEL_MESSAGE, sendAnswer } from '../askAnswerError'
import { afterSendFailed, cancelSession, initialSession, nextAction } from './askFormSession'
import type { AskFormFrameField } from './parseAskHtml'

// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({ notifyInfo: vi.fn() }))

const FIELDS: AskFormFrameField[] = [{ kind: 'text', name: 'why', question: 'Why?', required: false, defaultValue: '' }]
const gone = { ok: false, error: { code: 'request-gone', message: 'SessionAgent s1: the question is no longer waiting for an answer' } }

describe('ask form cancel against a closed request (#2135)', () => {
  beforeEach(() => vi.stubGlobal('window', { refract: { chat: { answer: vi.fn().mockResolvedValue(gone) } } }))
  afterEach(() => vi.unstubAllGlobals())

  test('Given a cancelled frame is refused as request-gone, When the form session records it, Then it shows the cancel wording', async () => {
    const session = cancelSession(initialSession(FIELDS))
    const action = nextAction(session, FIELDS, [{ kind: 'question', requestId: 'r1', title: 'Why?', options: [], inputKind: 'text' }])
    if (action.type !== 'send') throw new Error('expected a send action')

    const failure = await sendAnswer('s1', action.requestId, action.answer)

    expect(failure).toBe(REQUEST_GONE_CANCEL_MESSAGE)
    expect(afterSendFailed(session, failure ?? '').error).toBe(REQUEST_GONE_CANCEL_MESSAGE)
  })
})
