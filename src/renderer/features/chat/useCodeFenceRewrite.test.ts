import { describe, expect, it } from 'vitest'
import { nextRewriteState, shouldRewrite, type RewriteGate } from './useCodeFenceRewrite'

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
