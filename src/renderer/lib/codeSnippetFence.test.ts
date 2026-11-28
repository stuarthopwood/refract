import { describe, expect, it } from 'vitest'
import { describeSnippetAnnouncement, findFenceRewrite, findPreviewBlock, normaliseFencesForSend } from './codeSnippetFence'
import { MAX_STYLED_DRAFT_LENGTH } from './markdownLineTokens'

/** Applies the edit the way the textarea does and returns the draft and caret. */
function rewrite(text: string, caret = text.length) {
  const edit = findFenceRewrite(text, caret)
  if (!edit) return null
  return { text: text.slice(0, edit.from) + edit.insert + text.slice(edit.to), caret: edit.selStart, edit }
}

describe('findFenceRewrite', () => {
  it('rewrites a language-tagged one-line block to three lines with a lowercase tag', () => {
    const out = rewrite('```TS const bs = "x"```')
    expect(out?.text).toBe('```ts\nconst bs = "x"\n```\n')
    expect(out?.caret).toBe(out!.text.length)
  })

  it('gives a block whose first word is not a language no tag and keeps the whole text', () => {
    expect(rewrite('```hello world```')?.text).toBe('```\nhello world\n```\n')
  })

  it('does not swallow a prose word that is also a short alias', () => {
    expect(rewrite('```go away```')?.text).toBe('```\ngo away\n```\n')
    expect(rewrite('```c is```')?.text).toBe('```\nc is\n```\n')
  })

  it('treats a lone word as the body, not a tag', () => {
    expect(rewrite('```ts```')?.text).toBe('```\nts\n```\n')
  })

  it('moves a block that follows prose onto its own lines', () => {
    expect(rewrite('look: ```py print(1)```')?.text).toBe('look: \n```py\nprint(1)\n```\n')
  })

  it('keeps text after the block on the next line and lands the caret past the existing newline', () => {
    const out = rewrite('```py print(1)```\nafter', 17)
    expect(out?.text).toBe('```py\nprint(1)\n```\nafter')
    expect(out?.caret).toBe('```py\nprint(1)\n```\n'.length)
  })

  it('puts the caret on a new line when the block closes mid-line', () => {
    const out = rewrite('a ```sh ls``` tail', 'a ```sh ls```'.length)
    expect(out?.text).toBe('a \n```sh\nls\n```\n tail')
    expect(out?.caret).toBe('a \n```sh\nls\n```\n'.length)
  })

  it('rewrites a block on a later line', () => {
    expect(rewrite('first\n```json {"a":1}```')?.text).toBe('first\n```json\n{"a":1}\n```\n')
  })

  it('leaves a canonical multi-line fence alone, including a newline right after the language', () => {
    expect(rewrite('```py\nprint(1)\n```')).toBeNull()
  })

  it('does nothing when the caret is not right after a closing triple', () => {
    expect(rewrite('```ts x```', 5)).toBeNull()
    expect(rewrite('```ts x``` more')).toBeNull()
  })

  it('does nothing for a triple inside an open canonical fence', () => {
    expect(rewrite('```py\nx = 1 ```')).toBeNull()
    expect(rewrite('```py\na\n```\n```ts b```')?.text).toBe('```py\na\n```\n```ts\nb\n```\n')
  })

  it('does nothing for a slash draft or an empty block', () => {
    expect(rewrite('/model ```ts a```')).toBeNull()
    expect(rewrite('``` ```')).toBeNull()
  })

  it('rewrites a draft of exactly the styling limit and leaves one character more alone', () => {
    const draftOfLength = (length: number) => '```ts ' + 'x'.repeat(length - 9) + '```'
    const atLimit = draftOfLength(MAX_STYLED_DRAFT_LENGTH)
    expect(atLimit.length).toBe(MAX_STYLED_DRAFT_LENGTH)
    const out = rewrite(atLimit)
    expect(out?.text).toBe('```ts\n' + 'x'.repeat(MAX_STYLED_DRAFT_LENGTH - 9) + '\n```\n')
    expect(out?.caret).toBe(out!.text.length)
    expect(rewrite(draftOfLength(MAX_STYLED_DRAFT_LENGTH + 1))).toBeNull()
  })

  it('leaves four backticks and tilde fences untouched', () => {
    expect(rewrite('````ts a````')).toBeNull()
    expect(rewrite('~~~ts a~~~')).toBeNull()
    expect(rewrite('```ts a````')).toBeNull()
  })

  it('selects a collapsed caret after the closing fence', () => {
    const edit = findFenceRewrite('```ts a```', 10)!
    expect(edit.selStart).toBe(edit.selEnd)
    expect(edit.from).toBe(0)
    expect(edit.to).toBe(10)
  })
})

describe('findPreviewBlock', () => {
  it('returns the last fenced block when there are several', () => {
    expect(findPreviewBlock('```py\na\n```\ntext\n```ts\nb\nc\n```')).toEqual({ tag: 'ts', body: 'b\nc', lineCount: 2 })
  })

  it('runs an unclosed fence to the end of the draft', () => {
    expect(findPreviewBlock('```py\nx = 1\ny = 2')).toEqual({ tag: 'py', body: 'x = 1\ny = 2', lineCount: 2 })
  })

  it('does not count the newline just typed as a body line', () => {
    expect(findPreviewBlock('```py\nx = 1\n')?.lineCount).toBe(1)
  })

  it('previews a tilde fence and a fence with no tag', () => {
    expect(findPreviewBlock('~~~rs\nfn a() {}\n~~~')).toEqual({ tag: 'rs', body: 'fn a() {}', lineCount: 1 })
    expect(findPreviewBlock('```\nplain\n```')?.tag).toBeNull()
  })

  it('returns null with no fence, an empty body, a slash draft or an unconverted one-line block', () => {
    expect(findPreviewBlock('just text')).toBeNull()
    expect(findPreviewBlock('```py\n```')).toBeNull()
    expect(findPreviewBlock('/cmd\n```py\nx\n```')).toBeNull()
    expect(findPreviewBlock('```ts a```')).toBeNull()
  })

  it('keeps a three-backtick fence inside a four-backtick fence as body', () => {
    expect(findPreviewBlock('````md\n```ts\ncode\n```\n````')).toEqual({ tag: 'md', body: '```ts\ncode\n```', lineCount: 3 })
  })

  it('does not close a backtick fence with a tilde fence', () => {
    expect(findPreviewBlock('```py\n~~~\nx\n```')).toEqual({ tag: 'py', body: '~~~\nx', lineCount: 2 })
  })

  it('does not close a fence with a closer that carries an info string', () => {
    expect(findPreviewBlock('```py\na\n```ts\nb')).toEqual({ tag: 'py', body: 'a\n```ts\nb', lineCount: 3 })
  })

  it('lowercases a known tag', () => {
    expect(findPreviewBlock('```TS\na\n```')?.tag).toBe('ts')
  })

  it('gives an unknown or inherited-property tag no language', () => {
    expect(findPreviewBlock('```zig\na\n```')?.tag).toBeNull()
    expect(findPreviewBlock('```constructor\na\n```')?.tag).toBeNull()
  })
})

describe('describeSnippetAnnouncement', () => {
  it('names the language and the line count, singular for one line', () => {
    expect(describeSnippetAnnouncement({ tag: 'ts', body: 'a', lineCount: 1 })).toBe('TypeScript code block, 1 line')
    expect(describeSnippetAnnouncement({ tag: 'py', body: 'a\nb\nc', lineCount: 3 })).toBe('Python code block, 3 lines')
  })

  it('says text for an unknown or missing tag', () => {
    expect(describeSnippetAnnouncement({ tag: 'zig', body: 'a', lineCount: 2 })).toBe('text code block, 2 lines')
    expect(describeSnippetAnnouncement({ tag: null, body: 'a', lineCount: 1 })).toBe('text code block, 1 line')
  })

  it('changes with the language and, by choice, with the line count (the component gates when it is announced)', () => {
    const base = { tag: 'ts', body: 'a', lineCount: 1 }
    expect(describeSnippetAnnouncement({ ...base, tag: 'py' })).not.toBe(describeSnippetAnnouncement(base))
    expect(describeSnippetAnnouncement({ ...base, lineCount: 2 })).not.toBe(describeSnippetAnnouncement(base))
  })
})

describe('normaliseFencesForSend', () => {
  const samples = [
    'plain text',
    'a `inline` and ``double`` code',
    '```ts a```',
    'x ```py print(1)``` y',
    '```ts a``` and ```sh ls```',
    '```py\nprint(1)\n```',
    '```py\r\nx = ```ts a```\r\n```',
    'one\r\n```ts a```\r\ntwo',
    '```ts a```\n```\nopen forever ```sh b```',
    'text ```unclosed',
    '````ts a````',
    '~~~\n```ts a```\n~~~'
  ]

  it('returns fence-free text byte-identical', () => {
    for (const text of ['', 'hello', 'a `b` c', 'line\r\nline', 'a ``b`` c']) expect(normaliseFencesForSend(text)).toBe(text)
  })

  it('turns a one-line block into three parts wherever it sits', () => {
    expect(normaliseFencesForSend('```TS const a = 1```')).toBe('```ts\nconst a = 1\n```')
    expect(normaliseFencesForSend('before\n```hello world```\nafter')).toBe('before\n```\nhello world\n```\nafter')
    expect(normaliseFencesForSend('x ```py print(1)``` y')).toBe('x \n```py\nprint(1)\n```\n y')
  })

  it('keeps the original line endings for CRLF drafts', () => {
    expect(normaliseFencesForSend('one\r\n```ts a```\r\ntwo')).toBe('one\r\n```ts\r\na\r\n```\r\ntwo')
  })

  it('puts every block of a line on its own lines and keeps the text between them', () => {
    expect(normaliseFencesForSend('```ts a``` and ```sh ls```')).toBe('```ts\na\n```\n and \n```sh\nls\n```')
  })

  it('leaves a one-line block after an open fence untouched, including the closing line', () => {
    expect(normaliseFencesForSend('```ts a```\n```\nopen forever ```sh b```')).toBe('```ts\na\n```\n```\nopen forever ```sh b```')
    expect(normaliseFencesForSend('~~~\n```ts a```\n~~~')).toBe('~~~\n```ts a```\n~~~')
    expect(normaliseFencesForSend('````ts a````')).toBe('````ts a````')
  })

  it('leaves a canonical fence untouched', () => {
    const text = '```py\nprint(1)\n```\ntail'
    expect(normaliseFencesForSend(text)).toBe(text)
  })

  it('leaves a one-line fence inside a canonical fence untouched', () => {
    const text = '```md\nuse ```ts a``` here\n```'
    expect(normaliseFencesForSend(text)).toBe(text)
  })

  it('leaves backticks in prose without a closing triple untouched', () => {
    expect(normaliseFencesForSend('open ```ts never closed')).toBe('open ```ts never closed')
  })

  it('leaves a slash command untouched', () => {
    const text = '/review ```ts a```'
    expect(normaliseFencesForSend(text)).toBe(text)
  })

  it('leaves a line with a stray extra triple untouched', () => {
    const text = '```a``` ```b'
    expect(normaliseFencesForSend(text)).toBe(text)
  })

  it('is idempotent', () => {
    for (const text of samples) {
      const once = normaliseFencesForSend(text)
      expect(normaliseFencesForSend(once)).toBe(once)
    }
  })
})
