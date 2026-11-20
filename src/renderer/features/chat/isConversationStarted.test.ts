import { describe, expect, it } from 'vitest'
import { STARTUP_NOTICE_PREFIX, type TranscriptItem } from '../../../shared/model'
import { isConversationStarted } from './isConversationStarted'

function startupNotice(source?: 'extension', level: 'info' | 'warning' | 'error' = 'info'): TranscriptItem {
  return { kind: 'notice', id: `${STARTUP_NOTICE_PREFIX}1`, level, text: 'Ready.', source }
}

describe('isConversationStarted (#2114)', () => {
  it('counts a startup notice from an extension as conversation output', () => {
    expect(isConversationStarted([startupNotice('extension')])).toBe(true)
  })

  it('keeps a startup notice with no source hidden', () => {
    expect(isConversationStarted([startupNotice()])).toBe(false)
  })

  it('keeps a sourceless startup warning hidden', () => {
    expect(isConversationStarted([startupNotice(undefined, 'warning')])).toBe(false)
  })

  it('counts an extension startup error as conversation output', () => {
    expect(isConversationStarted([startupNotice('extension', 'error')])).toBe(true)
  })
})
