import { describe, expect, it } from 'vitest'
import { STARTUP_NOTICE_PREFIX, type TranscriptItem } from '../../../shared/model'
import { isConversationStarted } from './isConversationStarted'

function startupNotice(source?: 'extension'): TranscriptItem {
  return { kind: 'notice', id: `${STARTUP_NOTICE_PREFIX}1`, level: 'info', text: 'Ready.', source }
}

describe('isConversationStarted (#2114)', () => {
  it('counts a startup notice from an extension as conversation output', () => {
    expect(isConversationStarted([startupNotice('extension')])).toBe(true)
  })

  it('keeps a startup notice with no source hidden', () => {
    expect(isConversationStarted([startupNotice()])).toBe(false)
  })
})
