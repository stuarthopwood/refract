// #525: rewrites a just-closed one-line code block into a fenced block in the draft itself, through
// `applyEdit` so Ctrl+Z is one native undo step. An undo right after a rewrite sets the literal
// flag: the typed backticks are then left alone, on screen and on send.
import { useCallback, useEffect, useRef, type ChangeEvent, type RefObject } from 'react'
import { findFenceRewrite } from '@/lib/codeSnippetFence'
import { applyEdit } from './composerIndent'

export interface RewriteState {
  literal: boolean
  justRewrote: boolean
}

const INITIAL_STATE: RewriteState = { literal: false, justRewrote: false }

export interface RewriteGate {
  inputType: string
  isComposing: boolean
  literal: boolean
  text: string
  enabled: boolean
}

/** Only typed or pasted text may rewrite; undo, redo, IME composition and the literal flag never do. */
export function shouldRewrite({ inputType, isComposing, literal, text, enabled }: RewriteGate): boolean {
  if (!enabled || literal || isComposing || text.trimStart().startsWith('/')) return false
  return inputType === 'insertText' || inputType === 'insertFromPaste'
}

/** The state after one input: undo straight after a rewrite sets the flag, an empty draft clears it. */
export function nextRewriteState(state: RewriteState, inputType: string, text: string, rewrote: boolean): RewriteState {
  if (text === '') return INITIAL_STATE
  if (inputType === 'historyUndo' && state.justRewrote) return { literal: true, justRewrote: false }
  return { literal: state.literal, justRewrote: rewrote }
}

interface CodeFenceRewriteOptions {
  sessionId: string
  text: string
  enabled: boolean
}

export function useCodeFenceRewrite(textareaRef: RefObject<HTMLTextAreaElement | null>, { sessionId, text: draft, enabled }: CodeFenceRewriteOptions) {
  const stateRef = useRef<RewriteState>(INITIAL_STATE)
  // The edit's own input event re-enters the textarea's `onChange`; it must not count as typing.
  const applyingRef = useRef(false)
  const draftEmpty = draft === ''
  // A sent or cleared draft, or another Session's draft, starts without the literal flag.
  useEffect(() => {
    stateRef.current = INITIAL_STATE
  }, [sessionId, draftEmpty])

  /** Call last in the textarea's `onChange`, after the draft store has the typed value. */
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      if (applyingRef.current) return
      const textarea = textareaRef.current
      const { inputType = '', isComposing = false } = event.nativeEvent as InputEvent
      const text = event.target.value
      const state = stateRef.current
      const edit =
        textarea && shouldRewrite({ inputType, isComposing, literal: state.literal, text, enabled })
          ? findFenceRewrite(text, event.target.selectionStart ?? text.length)
          : null
      if (edit && textarea) {
        applyingRef.current = true
        try {
          applyEdit(textarea, edit)
        } finally {
          applyingRef.current = false
        }
      }
      stateRef.current = nextRewriteState(state, inputType, text, edit !== null)
    },
    [textareaRef, enabled]
  )

  /** True when the draft must go out exactly as typed. */
  const isLiteral = useCallback(() => stateRef.current.literal, [])

  return { handleChange, isLiteral }
}
