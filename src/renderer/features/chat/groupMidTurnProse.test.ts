// #1663 / FR-117: only short narration that has more of the turn after it collapses to a Note row.
import { describe, expect, it } from 'vitest'
import type { AdvisoryRun } from './groupAdvisoryItems'
import type { StageGroupedItem } from './groupSubagentStages'
import { groupMidTurnProse } from './groupMidTurnProse'

type Row = StageGroupedItem | AdvisoryRun

const text = (id: string, body: string) => ({ kind: 'assistant-text', id, text: body }) as unknown as Row
const tool = (id: string) => ({ kind: 'tool', id }) as unknown as Row
const kinds = (rows: Row[]) => groupMidTurnProse(rows).map((row) => row.kind)

describe('groupMidTurnProse size rule (#1663)', () => {
  it('collapses short narration followed by a tool call', () => {
    expect(kinds([text('a', 'Checking the config.'), tool('t')])).toEqual(['mid-turn-prose', 'tool'])
  })

  it('keeps a long final report a normal reply even when a tool call follows', () => {
    const report = 'x'.repeat(281)
    expect(kinds([text('a', report), tool('t')])).toEqual(['assistant-text', 'tool'])
  })

  it('keeps a reply of more than three lines a normal reply', () => {
    expect(kinds([text('a', 'one\ntwo\nthree\nfour'), tool('t')])).toEqual(['assistant-text', 'tool'])
  })

  it('still collapses at exactly three lines and 280 characters', () => {
    expect(kinds([text('a', 'one\ntwo\nthree'), tool('t')])).toEqual(['mid-turn-prose', 'tool'])
    expect(kinds([text('a', 'y'.repeat(280)), tool('t')])).toEqual(['mid-turn-prose', 'tool'])
  })

  it('leaves the last reply of the turn alone', () => {
    expect(kinds([tool('t'), text('a', 'Done.')])).toEqual(['tool', 'assistant-text'])
  })

  it('treats a short closing text as the follower that makes a long reply before it mid-turn only when short', () => {
    expect(kinds([text('a', 'x'.repeat(400)), text('b', 'Done.')])).toEqual(['assistant-text', 'assistant-text'])
  })
})
