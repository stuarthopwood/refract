// The repo has no jsdom, so the history list is checked as the markup its rows render and through the pure
// helpers the switcher and its delete flow share (sizes, total, refusals, freed-space message).
import { createElement } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConversationInfo } from '../../../shared/model'
import { ConversationRow } from './ConversationRow'
import {
  CURRENT_CONVERSATION_REFUSAL,
  NOT_IDLE_REFUSAL,
  deleteRefusal,
  freedMessage,
  historySummary,
  totalSizeBytes
} from './conversationDelete'

function conversation(over: Partial<ConversationInfo> = {}): ConversationInfo {
  return { file: 'a.jsonl', id: 'a', createdAt: '2026-11-01T10:00:00Z', title: 'Fix the build', preview: '', isCurrent: false, sizeBytes: 2048, ...over }
}

function row(info: ConversationInfo, over: { deleting?: boolean; openDisabled?: boolean } = {}): string {
  const props = { conversation: info, openDisabled: false, deleting: false, onOpen: () => undefined, onDelete: () => undefined, ...over }
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ConversationRow, props)))
}

describe('Conversation size and total (SC-032)', () => {
  it('Given three Conversations, When the history is summarised, Then the total equals the sum of the rows', () => {
    const list = [conversation({ sizeBytes: 1024 }), conversation({ file: 'b.jsonl', sizeBytes: 1024 * 1024 }), conversation({ file: 'c.jsonl', sizeBytes: 0 })]
    expect(totalSizeBytes(list)).toBe(1024 + 1024 * 1024)
    expect(historySummary(list)).toBe('3 Conversations · 1.0 MB total')
  })

  it('Given one Conversation, When summarised, Then the noun is singular', () => {
    expect(historySummary([conversation({ sizeBytes: 512 })])).toBe('1 Conversation · 512 B total')
  })

  it('Given a Conversation, When its row renders, Then the size shows and a delete button is named for it', () => {
    const html = row(conversation())
    expect(html).toContain('2.0 KB')
    expect(html).toContain('aria-label="Delete Fix the build"')
  })

  it('Given a Conversation with no title, When its row renders, Then the fallback title is used', () => {
    expect(row(conversation({ title: '' }))).toContain('Delete Untitled conversation')
  })

  it('Given a delete in flight, When the row renders, Then it reads Deleting and the delete button is inert', () => {
    const html = row(conversation(), { deleting: true })
    expect(html).toContain('Deleting…')
    expect(html).toContain('aria-disabled="true"')
  })
})

describe('Delete refusals (SC-031, FR-187)', () => {
  it('Given the current Conversation, When asked to delete, Then it is refused whatever the Session is doing', () => {
    expect(deleteRefusal(conversation({ isCurrent: true }), true)).toBe(CURRENT_CONVERSATION_REFUSAL)
    expect(deleteRefusal(conversation({ isCurrent: true }), false)).toBe(CURRENT_CONVERSATION_REFUSAL)
  })

  it('Given a working Session, When asked to delete a non-current Conversation, Then it is refused with the reason', () => {
    expect(deleteRefusal(conversation(), false)).toBe(NOT_IDLE_REFUSAL)
  })

  it('Given an idle Session, When asked to delete a non-current Conversation, Then nothing refuses it', () => {
    expect(deleteRefusal(conversation(), true)).toBeNull()
  })
})

describe('Freed space report (FR-186)', () => {
  it('Given a deleted Conversation, When reported, Then the title and bytes freed are named', () => {
    expect(freedMessage('Fix the build', 3 * 1024 * 1024)).toBe('Deleted “Fix the build”. Freed 3.0 MB.')
  })
})
