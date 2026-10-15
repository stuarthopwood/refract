import { create } from 'zustand'

// New for #572: picks for the ask card's structured dialog (`PendingRequest` kind `ask`),
// keyed by sessionId then requestId (decision D27), matching `draft-store.ts`'s own
// `bySession: Record<string, T>` shape and its reasoning (nothing here is ever pushed from
// main, only typed/clicked locally). Survives switching Sessions, panes, and Settings; cannot
// survive an app or OMP restart (`PendingRequest` does not survive a process restart,
// `src/shared/model.ts:547`) -- a restart simply never restores this store's entry for a
// requestId that no longer has a live pending request, so there is nothing to clear on restart,
// only on resolution (`clear`, called once the card submits, cancels, or OMP cancels it).

export interface AskDraftQuestion {
  /** Single choice: at most one label, the chosen real option; empty while Other is the active
   * pick. Multiple choice: any number of ticked option labels, never including "Other" itself. */
  selectedOptions: string[]
  /** Free text typed into the always-visible Other input. A single-choice question keeps this
   * on screen even after a real option is clicked afterwards (decision D12), so it never
   * silently disappears; only `otherSelected`/`otherTicked` below decide whether it is sent. */
  customInput: string
  /** Single choice only (ignored for multiple choice): true once the user has typed into Other
   * and not since clicked a real option -- Other is what Submit will send for this question. */
  otherSelected: boolean
  /** Multiple choice only (ignored for single choice): whether the Other row's own checkbox is
   * ticked, independent of whether its input already has text. */
  otherTicked: boolean
  /** True once this question's tab has been opened at least once. A multiple-choice question
   * counts as complete once viewed, even with nothing ticked (decision D13/D15: an empty
   * multi-select answer is allowed). */
  viewed: boolean
}

export const EMPTY_ASK_QUESTION_DRAFT: AskDraftQuestion = {
  selectedOptions: [],
  customInput: '',
  otherSelected: false,
  otherTicked: false,
  viewed: false
}

export interface AskDraft {
  byQuestionId: Record<string, AskDraftQuestion>
  activeQuestionId?: string
}

const EMPTY_ASK_DRAFT: AskDraft = { byQuestionId: {} }

interface AskPicksState {
  bySession: Record<string, Record<string, AskDraft>>
  /** Marks `questionId` as the open tab and, since opening a tab is the only way to "view" a
   * multiple-choice question, also marks it viewed. */
  setActiveQuestion(sessionId: string, requestId: string, questionId: string): void
  selectSingleOption(sessionId: string, requestId: string, questionId: string, label: string): void
  toggleMultiOption(sessionId: string, requestId: string, questionId: string, label: string): void
  /** `multi` decides which precedence field (`otherSelected` vs leaving `otherTicked` alone)
   * typing affects; a multiple-choice question's own checkbox state is set separately via
   * `toggleOtherTicked`. */
  setCustomInput(sessionId: string, requestId: string, questionId: string, text: string, multi: boolean): void
  toggleOtherTicked(sessionId: string, requestId: string, questionId: string): void
  clear(sessionId: string, requestId: string): void
}

function getQuestionDraft(state: AskPicksState, sessionId: string, requestId: string, questionId: string): AskDraftQuestion {
  return state.bySession[sessionId]?.[requestId]?.byQuestionId[questionId] ?? EMPTY_ASK_QUESTION_DRAFT
}

export const useAskPicksStore = create<AskPicksState>((set, get) => ({
  bySession: {},
  setActiveQuestion: (sessionId, requestId, questionId) => {
    const state = get()
    const draft = state.bySession[sessionId]?.[requestId] ?? EMPTY_ASK_DRAFT
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    set({
      bySession: {
        ...state.bySession,
        [sessionId]: {
          ...state.bySession[sessionId],
          [requestId]: {
            ...draft,
            activeQuestionId: questionId,
            byQuestionId: { ...draft.byQuestionId, [questionId]: { ...question, viewed: true } }
          }
        }
      }
    })
  },
  selectSingleOption: (sessionId, requestId, questionId, label) => {
    const state = get()
    const draft = state.bySession[sessionId]?.[requestId] ?? EMPTY_ASK_DRAFT
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    set({
      bySession: {
        ...state.bySession,
        [sessionId]: {
          ...state.bySession[sessionId],
          [requestId]: {
            ...draft,
            byQuestionId: { ...draft.byQuestionId, [questionId]: { ...question, selectedOptions: [label], otherSelected: false } }
          }
        }
      }
    })
  },
  toggleMultiOption: (sessionId, requestId, questionId, label) => {
    const state = get()
    const draft = state.bySession[sessionId]?.[requestId] ?? EMPTY_ASK_DRAFT
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    const selectedOptions = question.selectedOptions.includes(label)
      ? question.selectedOptions.filter((option) => option !== label)
      : [...question.selectedOptions, label]
    set({
      bySession: {
        ...state.bySession,
        [sessionId]: {
          ...state.bySession[sessionId],
          [requestId]: { ...draft, byQuestionId: { ...draft.byQuestionId, [questionId]: { ...question, selectedOptions } } }
        }
      }
    })
  },
  setCustomInput: (sessionId, requestId, questionId, text, multi) => {
    const state = get()
    const draft = state.bySession[sessionId]?.[requestId] ?? EMPTY_ASK_DRAFT
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    const next: AskDraftQuestion = multi
      ? { ...question, customInput: text }
      : { ...question, customInput: text, otherSelected: text.trim().length > 0 }
    set({
      bySession: {
        ...state.bySession,
        [sessionId]: { ...state.bySession[sessionId], [requestId]: { ...draft, byQuestionId: { ...draft.byQuestionId, [questionId]: next } } }
      }
    })
  },
  toggleOtherTicked: (sessionId, requestId, questionId) => {
    const state = get()
    const draft = state.bySession[sessionId]?.[requestId] ?? EMPTY_ASK_DRAFT
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    set({
      bySession: {
        ...state.bySession,
        [sessionId]: {
          ...state.bySession[sessionId],
          [requestId]: { ...draft, byQuestionId: { ...draft.byQuestionId, [questionId]: { ...question, otherTicked: !question.otherTicked } } }
        }
      }
    })
  },
  clear: (sessionId, requestId) => {
    const state = get()
    const bySessionEntry = { ...state.bySession[sessionId] }
    delete bySessionEntry[requestId]
    set({ bySession: { ...state.bySession, [sessionId]: bySessionEntry } })
  }
}))
