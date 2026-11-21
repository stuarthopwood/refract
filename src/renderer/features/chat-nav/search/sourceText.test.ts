import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../../../shared/model'
import { sourceTextById } from './sourceText'

const items: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: 'The developer asks you to do this step yourself.\n> Run the migration', at: 1, source: { kind: 'checklist-item', checklistId: 'p1', itemId: 'i1', action: 'complete' } },
  { kind: 'user', id: 'u2', text: 'hello', at: 2 },
  { kind: 'assistant-text', id: 'a1', text: 'done' } as TranscriptItem
]

describe('sourceTextById', () => {
  it('find_searches_the_complete_phrase_not_the_quoted_envelope', () => {
    const text = sourceTextById(items)
    expect(text.get('u1')).toBe('Asked the agent to complete this step')
    expect(text.get('u1')).not.toContain('Run the migration')
  })

  it('keeps_ordinary_user_and_agent_text', () => {
    const text = sourceTextById(items)
    expect(text.get('u2')).toBe('hello')
    expect(text.get('a1')).toBe('done')
  })
})
