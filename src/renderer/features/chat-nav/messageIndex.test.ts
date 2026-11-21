import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { buildMessageIndex } from './messageIndex'

const ENVELOPE = 'The developer asks you to do this step yourself.\n> Run the migration'

const items: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: ENVELOPE, at: 1, source: { kind: 'checklist-item', checklistId: 'p1', itemId: 'i1', action: 'complete' } },
  { kind: 'user', id: 'u2', text: 'Is this safe?', at: 2, source: { kind: 'checklist-item', checklistId: 'p1', itemId: 'i1', action: 'ask' } }
]

describe('buildMessageIndex checklist turns', () => {
  it('outline_reads_the_complete_phrase_not_the_quoted_envelope', () => {
    const [complete] = buildMessageIndex(items)
    expect(complete!.firstLine).toBe('Asked the agent to complete this step')
    expect(complete!.length).toBe('Asked the agent to complete this step'.length)
  })

  it('outline_keeps_the_words_of_an_ask_turn', () => {
    expect(buildMessageIndex(items)[1]!.firstLine).toBe('Is this safe?')
  })
})
