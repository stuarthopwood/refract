import { describe, expect, it } from 'vitest'
import { decideChange, nextRewriteState, shouldRewrite, textForSend, type ChangeInput, type RewriteGate } from './useCodeFenceRewrite'

const gate = (over: Partial<RewriteGate> = {}): RewriteGate => ({ inputType: 'insertText', isComposing: false, literal: false, text: '```ts a```', enabled: true, ...over })

describe('shouldRewrite', () => {
  it('rewrites typed and pasted text', () => {
    expect(shouldRewrite(gate())).toBe(true)
    expect(shouldRewrite(gate({ inputType: 'insertFromPaste' }))).toBe(true)
  })

  it.each(['historyUndo', 'historyRedo', 'deleteContentBackward', 'insertLineBreak', ''])('does not rewrite on %s', (inputType) => {
    expect(shouldRewrite(gate({ inputType }))).toBe(false)
  })

  it('does not rewrite during IME composition', () => {
    expect(shouldRewrite(gate({ isComposing: true }))).toBe(false)
  })

  it('does not rewrite once the literal flag is set', () => {
    expect(shouldRewrite(gate({ literal: true }))).toBe(false)
  })

  it('does not rewrite a slash draft, even one with leading space', () => {
    expect(shouldRewrite(gate({ text: '/run ```ts a```' }))).toBe(false)
    expect(shouldRewrite(gate({ text: '  /run ```ts a```' }))).toBe(false)
  })

  it('does not rewrite while disabled', () => {
    expect(shouldRewrite(gate({ enabled: false }))).toBe(false)
  })
})

describe('nextRewriteState', () => {
  const fresh = { literal: false, justRewrote: false }

  it('remembers that the last input was a rewrite', () => {
    expect(nextRewriteState(fresh, 'insertText', 'x', true)).toEqual({ literal: false, justRewrote: true })
  })

  it('sets the literal flag only for an undo directly after a rewrite', () => {
    expect(nextRewriteState({ literal: false, justRewrote: true }, 'historyUndo', 'x', false)).toEqual({ literal: true, justRewrote: false })
    expect(nextRewriteState(fresh, 'historyUndo', 'x', false)).toEqual({ literal: false, justRewrote: false })
  })

  it('does not set the flag when typing came between the rewrite and the undo', () => {
    const afterTyping = nextRewriteState({ literal: false, justRewrote: true }, 'insertText', 'x', false)
    expect(nextRewriteState(afterTyping, 'historyUndo', 'x', false).literal).toBe(false)
  })

  it('keeps the flag through further typing and clears it on an empty draft', () => {
    const literal = { literal: true, justRewrote: false }
    expect(nextRewriteState(literal, 'insertText', 'x', false).literal).toBe(true)
    expect(nextRewriteState(literal, 'deleteContentBackward', '', false)).toEqual(fresh)
  })
})

describe('decideChange', () => {
  const fresh = { literal: false, justRewrote: false }
  const change = (over: Partial<ChangeInput> = {}): ChangeInput => ({ applying: false, inputType: 'insertText', isComposing: false, text: '```ts a```', caret: 10, enabled: true, ...over })

  it('rewrites a block closed at the caret and remembers it for the next undo', () => {
    const out = decideChange(fresh, change())
    expect(out.edit).toMatchObject({ from: 0, to: 10, insert: '```ts\na\n```\n' })
    expect(out.state).toEqual({ literal: false, justRewrote: true })
  })

  it('takes the caret from the selection, not the end of the draft', () => {
    expect(decideChange(fresh, change({ text: '```ts a``` more', caret: 10 })).edit).toMatchObject({ from: 0, to: 10 })
    expect(decideChange(fresh, change({ text: '```ts a``` more', caret: 15 })).edit).toBeNull()
  })

  it('falls back to the end of the draft when the selection is unavailable', () => {
    expect(decideChange(fresh, change({ caret: null })).edit).toMatchObject({ from: 0, to: 10 })
  })

  it('ignores the input event of its own edit and keeps the state', () => {
    const state = { literal: false, justRewrote: true }
    expect(decideChange(state, change({ applying: true }))).toEqual({ edit: null, state })
  })

  it('sets the literal flag on an undo straight after a rewrite and then never rewrites again', () => {
    const undone = decideChange({ literal: false, justRewrote: true }, change({ inputType: 'historyUndo' }))
    expect(undone).toEqual({ edit: null, state: { literal: true, justRewrote: false } })
    expect(decideChange(undone.state, change()).edit).toBeNull()
  })

  it('does not rewrite while disabled, composing or on a slash draft', () => {
    expect(decideChange(fresh, change({ enabled: false })).edit).toBeNull()
    expect(decideChange(fresh, change({ isComposing: true })).edit).toBeNull()
    expect(decideChange(fresh, change({ text: '/run ```ts a```' })).edit).toBeNull()
  })

  it('clears the literal flag when the draft is emptied', () => {
    expect(decideChange({ literal: true, justRewrote: false }, change({ inputType: 'deleteContentBackward', text: '', caret: 0 })).state).toEqual(fresh)
  })
})

describe('textForSend', () => {
  it('normalises a one-line block on a normal send', () => {
    expect(textForSend('```ts a```', false)).toBe('```ts\na\n```')
  })

  it('sends a literal draft exactly as typed', () => {
    expect(textForSend('```ts a```', true)).toBe('```ts a```')
  })
})
