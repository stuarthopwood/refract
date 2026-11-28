import { describe, expect, it } from 'vitest'
import { splitContextLines } from './contextLines'

describe('splitContextLines', () => {
  it('reads_an_away_reply_as_one_away_line_with_no_body', () => {
    expect(splitContextLines('[Automatic, Away mode] Answered by Away Mode.')).toEqual({ lines: [{ kind: 'away', text: 'Answered by Away Mode.' }], body: '' })
  })

  it('types_a_checklist_hint_apart_from_other_refract_lines', () => {
    const split = splitContextLines('[Refract] Handoff failed: boom\n[Refract] Checklist p1 is active.\n\nhello')
    expect(split.lines).toEqual([
      { kind: 'refract', text: 'Handoff failed: boom' },
      { kind: 'checklist', text: 'Checklist p1 is active.' }
    ])
    expect(split.body).toBe('hello')
  })

  it('keeps_the_typed_text_exactly_after_the_separator', () => {
    expect(splitContextLines('[Refract] a\r\n\r\n  indented\nsecond').body).toBe('  indented\nsecond')
  })

  it('stops_at_the_first_line_without_a_known_prefix', () => {
    const split = splitContextLines('[Refract] a\ntyped\n[Refract] b')
    expect(split.lines).toHaveLength(1)
    expect(split.body).toBe('typed\n[Refract] b')
  })

  it('leaves_text_without_a_leading_known_prefix_untouched', () => {
    for (const text of ['hello\n[Refract] a', '[Other] a', '[Refract]no space', '[Refract] ', '']) {
      expect(splitContextLines(text)).toEqual({ lines: [], body: text })
    }
  })
})
