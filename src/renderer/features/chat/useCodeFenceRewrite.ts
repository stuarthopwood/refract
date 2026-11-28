// #525: rewrites a just-closed one-line code block into a fenced block in the draft itself, through
// `applyEdit` so Ctrl+Z is one native undo step. An undo right after a rewrite sets the literal
// flag: the typed backticks are then left alone, on screen and on send.
import { useCallback, useEffect, useRef, type ChangeEvent, type RefObject } from 'react'
import { findFenceRewrite, normaliseFencesForSend } from '@/lib/codeSnippetFence'
import { applyEdit, type ComposerEdit } from './composerIndent'

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

export interface ChangeInput extends Omit<RewriteGate, 'literal'> {
  /** True while the hook's own edit is re-entering `onChange`. */
  applying: boolean
  caret: number | null
}

/** What one `onChange` does: the rewrite to apply, if any, and the state afterwards. */
export function decideChange(state: RewriteState, { applying, caret, ...gate }: ChangeInput): { edit: ComposerEdit | null; state: RewriteState } {
  if (applying) return { edit: null, state }
  const edit = shouldRewrite({ ...gate, literal: state.literal }) ? findFenceRewrite(gate.text, caret ?? gate.text.length) : null
  return { edit, state: nextRewriteState(state, gate.inputType, gate.text, edit !== null) }
}

/** A literal draft goes out as typed; callers pass false for text that was not typed in this composer, where the flag means nothing. */
export function textForSend(draft: string, literal: boolean): string {
  return literal ? draft : normaliseFencesForSend(draft)
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
      const textarea = textareaRef.current
      const { inputType = '', isComposing = false } = event.nativeEvent as InputEvent
      const decision = decideChange(stateRef.current, {
        applying: applyingRef.current,
        inputType,
        isComposing,
        text: event.target.value,
        caret: event.target.selectionStart,
        enabled: enabled && textarea !== null
      })
      stateRef.current = decision.state
      if (!decision.edit || !textarea) return
      applyingRef.current = true
      try {
        applyEdit(textarea, decision.edit)
      } finally {
        applyingRef.current = false
      }
    },
    [textareaRef, enabled]
  )

  /** True when the draft must go out exactly as typed. */
  const isLiteral = useCallback(() => stateRef.current.literal, [])

  return { handleChange, isLiteral }
}
