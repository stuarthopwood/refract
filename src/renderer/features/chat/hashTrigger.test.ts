// #1789: the composer `#` picker opens only at a real `#query` token outside code.
import { describe, it, expect } from 'vitest'
import { applyHashPick, MAX_QUERY_CHARS, parseHashTrigger } from './hashTrigger'

/** Parses with the caret at the end of the text, as when typing. */
function atEnd(text: string) {
  return parseHashTrigger(text, text.length, text.length)
}

describe('parseHashTrigger', () => {
  describe('where a trigger opens', () => {
    it('opens for a # at the start of the draft', () => {
      expect(atEnd('#fo')).toEqual({ start: 0, query: 'fo' })
    })

    it('opens for a # after a space', () => {
      expect(atEnd('see #fo')).toEqual({ start: 4, query: 'fo' })
    })

    it('opens for a # at the start of a new line', () => {
      expect(atEnd('first line\n#fo')).toEqual({ start: 11, query: 'fo' })
    })

    it('opens with an empty query for a bare #', () => {
      expect(atEnd('see #')).toEqual({ start: 4, query: '' })
    })

    it('opens again after a closed inline code span', () => {
      expect(atEnd('`code` #fo')).toEqual({ start: 7, query: 'fo' })
    })

    it('opens again after a closed code fence', () => {
      const text = '```\ncode\n```\n#fo'
      expect(atEnd(text)).toEqual({ start: text.indexOf('#'), query: 'fo' })
    })

    it('opens after a blank line even when an earlier paragraph has an unclosed backtick', () => {
      const text = '`dangling\n\n#fo'
      expect(atEnd(text)).toEqual({ start: text.indexOf('#'), query: 'fo' })
    })
  })

  describe('where no trigger opens', () => {
    it('ignores a # in the middle of a word', () => {
      expect(atEnd('abc#fo')).toBeNull()
    })

    it('ignores the fragment # of a URL', () => {
      expect(atEnd('see https://example.com/page#section')).toBeNull()
    })

    it('ignores a token that holds a second #', () => {
      expect(atEnd('#a#b')).toBeNull()
    })

    it('ignores a token that does not start with #', () => {
      expect(atEnd('plain words')).toBeNull()
    })

    it('ignores a # inside an open inline code span', () => {
      expect(atEnd('`code #fo')).toBeNull()
    })

    it('ignores a # inside a double-backtick span that a single backtick does not close', () => {
      expect(atEnd('``a ` b #fo')).toBeNull()
    })

    it('ignores a # inside an open backtick fence', () => {
      expect(atEnd('```\n#fo')).toBeNull()
    })

    it('ignores a # inside an open tilde fence', () => {
      expect(atEnd('~~~ts\nconst a = 1\n#fo')).toBeNull()
    })

    it('keeps a long fence open when a shorter fence line appears', () => {
      expect(atEnd('````\n```\n#fo')).toBeNull()
    })

    it('ignores a # inside an inline span that wraps across lines', () => {
      expect(atEnd('`code\n#fo')).toBeNull()
    })

    it('ignores a query longer than the cap', () => {
      expect(atEnd(`#${'a'.repeat(MAX_QUERY_CHARS + 1)}`)).toBeNull()
    })

    it('accepts a query exactly at the cap', () => {
      const query = 'a'.repeat(MAX_QUERY_CHARS)
      expect(atEnd(`#${query}`)).toEqual({ start: 0, query })
    })
  })

  describe('caret and selection', () => {
    it('ignores a non-empty selection', () => {
      expect(parseHashTrigger('see #fo', 4, 7)).toBeNull()
    })

    it('ignores a caret beyond the end of the text', () => {
      expect(parseHashTrigger('#fo', 10, 10)).toBeNull()
    })

    it('takes the query only up to the caret', () => {
      const text = '#foo bar'
      expect(parseHashTrigger(text, 3, 3)).toEqual({ start: 0, query: 'fo' })
    })

    it('opens nothing when the caret sits after the space that ends the token', () => {
      expect(parseHashTrigger('#foo bar', 5, 5)).toBeNull()
    })

    it('opens with an empty query when the caret is right after the #', () => {
      expect(parseHashTrigger('#foo', 1, 1)).toEqual({ start: 0, query: '' })
    })

    it('ignores text after the caret, including code that opens later', () => {
      const text = 'see #fo `later'
      expect(parseHashTrigger(text, 7, 7)).toEqual({ start: 4, query: 'fo' })
    })
  })

  describe('unicode', () => {
    it('reports UTF-16 indices when an emoji precedes the token', () => {
      const text = '🎉 #fo'
      expect(atEnd(text)).toEqual({ start: 3, query: 'fo' })
      expect(text.slice(3)).toBe('#fo')
    })

    it('ignores a # glued to an emoji', () => {
      expect(atEnd('🎉#fo')).toBeNull()
    })

    it('keeps accented and emoji characters in the query', () => {
      expect(atEnd('héllo #café🎉')).toEqual({ start: 6, query: 'café🎉' })
    })

    it('treats a non-breaking space as whitespace before the #', () => {
      expect(atEnd('a\u00a0#fo')).toEqual({ start: 2, query: 'fo' })
    })
  })
})

describe('applyHashPick', () => {
  it('replaces the typed #query with #<number> and a trailing space', () => {
    const text = 'see #fo'
    const trigger = { start: 4, query: 'fo' }
    expect(applyHashPick(text, trigger, text.length, 42)).toEqual({ text: 'see #42 ', caret: 8 })
  })

  it('puts the caret just after the inserted space', () => {
    const result = applyHashPick('#a', { start: 0, query: 'a' }, 2, 7)
    expect(result.text).toBe('#7 ')
    expect(result.caret).toBe(3)
    expect(result.text.slice(0, result.caret)).toBe('#7 ')
  })

  it('keeps the text after the caret intact', () => {
    const text = 'see #fo and more'
    const result = applyHashPick(text, { start: 4, query: 'fo' }, 7, 1234)
    expect(result.text).toBe('see #1234  and more')
    expect(result.text.slice(result.caret)).toBe(' and more')
  })

  it('replaces only the query when the caret is mid-token', () => {
    const result = applyHashPick('#foo bar', { start: 0, query: 'fo' }, 3, 9)
    expect(result.text).toBe('#9 o bar')
    expect(result.caret).toBe(3)
  })

  it('round-trips with parseHashTrigger when an emoji precedes the token', () => {
    const text = '🎉 #fo'
    const trigger = atEnd(text)!
    expect(applyHashPick(text, trigger, text.length, 5)).toEqual({ text: '🎉 #5 ', caret: 6 })
  })
})
