import { describe, expect, it } from 'vitest'
import { HIDDEN_TOOL_NOTICE_PREFIX, type TranscriptItem } from '../../../../shared/model'
import { splitSubagentRuns } from './runs'
import { assistantText, subagentItem } from './testFixtures'

const hiddenNotice: TranscriptItem = { kind: 'notice', id: `${HIDDEN_TOOL_NOTICE_PREFIX}1`, level: 'error', text: 'boom' }

describe('splitSubagentRuns', () => {
  it('returns no slots for no items', () => {
    expect(splitSubagentRuns([])).toEqual([])
  })

  it('keeps consecutive subagent items of one message in one run', () => {
    const slots = splitSubagentRuns([subagentItem({ name: 'A' }), subagentItem({ name: 'B', specIndex: 1 })])
    expect(slots).toHaveLength(1)
    expect(slots[0]).toMatchObject({ kind: 'run' })
    expect(slots[0]!.kind === 'run' && slots[0]!.items.map((i) => i.name)).toEqual(['A', 'B'])
  })

  it('splits when the assistant message id changes', () => {
    const slots = splitSubagentRuns([subagentItem({ name: 'A', messageId: 'm1' }), subagentItem({ name: 'B', messageId: 'm2' })])
    expect(slots.map((slot) => slot.kind)).toEqual(['run', 'run'])
  })

  it('splits on any other item and keeps that item as its own slot', () => {
    const text = assistantText('t1')
    const slots = splitSubagentRuns([subagentItem({ name: 'A' }), text, subagentItem({ name: 'B', messageId: 'm2' })])
    expect(slots.map((slot) => slot.kind)).toEqual(['run', 'other', 'run'])
    expect(slots[1]).toEqual({ kind: 'other', item: text })
  })

  it('folds a later run of the same message into the first run, leaving the text after it', () => {
    // Mutation: flush on the text and keep both runs, so one message renders two cards that both read "Stage 1".
    const text = assistantText('t1')
    const slots = splitSubagentRuns([
      subagentItem({ name: 'A', messageId: 'm1' }),
      text,
      subagentItem({ name: 'B', id: 'call2:B', toolCallId: 'call2', messageId: 'm1' })
    ])
    expect(slots.map((slot) => slot.kind)).toEqual(['run', 'other'])
    expect(slots[0]!.kind === 'run' && slots[0]!.items.map((i) => i.name)).toEqual(['A', 'B'])
    expect(slots[1]).toEqual({ kind: 'other', item: text })
  })

  it('does not split on the invisible hidden-tool notice', () => {
    const slots = splitSubagentRuns([subagentItem({ name: 'A' }), hiddenNotice, subagentItem({ name: 'B', specIndex: 1 })])
    expect(slots.map((slot) => slot.kind)).toEqual(['other', 'run'])
    expect(slots[1]!.kind === 'run' && slots[1]!.items).toHaveLength(2)
  })
})
