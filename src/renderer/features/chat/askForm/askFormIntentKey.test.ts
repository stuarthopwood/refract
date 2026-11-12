import { describe, expect, it } from 'vitest'
import { askFormIntentKey } from './askFormIntentKey'

describe('askFormIntentKey', () => {
  it('joins the session and ask item ids the way AskCard keys its request id', () => {
    expect(askFormIntentKey('s1', 'call_1')).toBe('s1:call_1')
  })

  it('has no key without both ids, so the intent is never armed for nothing', () => {
    expect(askFormIntentKey(undefined, 'call_1')).toBeUndefined()
    expect(askFormIntentKey('s1', undefined)).toBeUndefined()
    expect(askFormIntentKey('', 'call_1')).toBeUndefined()
  })
})
