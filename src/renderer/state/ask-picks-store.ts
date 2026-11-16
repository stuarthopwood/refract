import { create } from 'zustand'

// Ask-card picks keyed by sessionId then requestId. Cleared only from init-stores.ts's
// `onRequestResolved`, the one event emitted for every resolution path (submit, cancel, timeout, settle).

export interface AskDraftQuestion {
  /** Single choice: at most one chosen option; empty while Other is active. Multiple: ticked options, never "Other". */
  selectedOptions: string[]
  /** Other-input text; kept on screen after a real option is picked, but only sent per `otherSelected`/`otherTicked`. */
  customInput: string
  /** Single choice only: Other is the active pick (typed into, or its radio clicked). */
  otherSelected: boolean
  /** Multiple choice only: Other's checkbox is ticked. Typing into an empty input auto-ticks it so text is never dropped; unticking keeps the text but stops sending it. */
  otherTicked: boolean
  /** The tab has been opened once; a viewed multiple-choice question counts as complete even if empty. */
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
  /** Marks `questionId` as the open tab and viewed. `preselect` (a single-choice question's recommended label) applies only on the first open, and never over a pick or Other already made. */
  setActiveQuestion(sessionId: string, requestId: string, questionId: string, preselect?: string): void
  selectSingleOption(sessionId: string, requestId: string, questionId: string, label: string): void
  /** Single choice only: the Other radio clicked with no text yet. */
  selectOther(sessionId: string, requestId: string, questionId: string): void
  toggleMultiOption(sessionId: string, requestId: string, questionId: string, label: string): void
  /** `multi` picks which Other field typing affects. */
  setCustomInput(sessionId: string, requestId: string, questionId: string, text: string, multi: boolean): void
  toggleOtherTicked(sessionId: string, requestId: string, questionId: string): void
  /** Replaces a question's whole draft; for "Use Recommended", which sets pick and Other together. */
  replaceQuestionDraft(sessionId: string, requestId: string, questionId: string, next: AskDraftQuestion): void
  clear(sessionId: string, requestId: string): void
}

function getQuestionDraft(state: AskPicksState, sessionId: string, requestId: string, questionId: string): AskDraftQuestion {
  return state.bySession[sessionId]?.[requestId]?.byQuestionId[questionId] ?? EMPTY_ASK_QUESTION_DRAFT
}

function updateQuestion(
  state: AskPicksState,
  sessionId: string,
  requestId: string,
  questionId: string,
  next: AskDraftQuestion,
  activeQuestionId?: string
): Pick<AskPicksState, 'bySession'> {
  const draft = state.bySession[sessionId]?.[requestId] ?? EMPTY_ASK_DRAFT
  return {
    bySession: {
      ...state.bySession,
      [sessionId]: {
        ...state.bySession[sessionId],
        [requestId]: {
          ...draft,
          ...(activeQuestionId ? { activeQuestionId } : {}),
          byQuestionId: { ...draft.byQuestionId, [questionId]: next }
        }
      }
    }
  }
}

export const useAskPicksStore = create<AskPicksState>((set, get) => ({
  bySession: {},
  setActiveQuestion: (sessionId, requestId, questionId, preselect) => {
    const state = get()
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    const untouched = !question.viewed && question.selectedOptions.length === 0 && !question.otherSelected
    const next = preselect !== undefined && untouched ? { ...question, selectedOptions: [preselect] } : question
    set(updateQuestion(state, sessionId, requestId, questionId, { ...next, viewed: true }, questionId))
  },
  selectSingleOption: (sessionId, requestId, questionId, label) => {
    const state = get()
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    set(updateQuestion(state, sessionId, requestId, questionId, { ...question, selectedOptions: [label], otherSelected: false }))
  },
  selectOther: (sessionId, requestId, questionId) => {
    const state = get()
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    set(updateQuestion(state, sessionId, requestId, questionId, { ...question, selectedOptions: [], otherSelected: true }))
  },
  toggleMultiOption: (sessionId, requestId, questionId, label) => {
    const state = get()
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    const selectedOptions = question.selectedOptions.includes(label)
      ? question.selectedOptions.filter((option) => option !== label)
      : [...question.selectedOptions, label]
    set(updateQuestion(state, sessionId, requestId, questionId, { ...question, selectedOptions }))
  },
  setCustomInput: (sessionId, requestId, questionId, text, multi) => {
    const state = get()
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    const next: AskDraftQuestion = multi
      ? { ...question, customInput: text, otherTicked: question.customInput.trim().length === 0 && text.trim().length > 0 ? true : question.otherTicked }
      : { ...question, customInput: text, otherSelected: text.trim().length > 0 }
    set(updateQuestion(state, sessionId, requestId, questionId, next))
  },
  toggleOtherTicked: (sessionId, requestId, questionId) => {
    const state = get()
    const question = getQuestionDraft(state, sessionId, requestId, questionId)
    set(updateQuestion(state, sessionId, requestId, questionId, { ...question, otherTicked: !question.otherTicked }))
  },
  replaceQuestionDraft: (sessionId, requestId, questionId, next) => set(updateQuestion(get(), sessionId, requestId, questionId, next)),
  clear: (sessionId, requestId) => {
    const state = get()
    const bySessionEntry = { ...state.bySession[sessionId] }
    delete bySessionEntry[requestId]
    set({ bySession: { ...state.bySession, [sessionId]: bySessionEntry } })
  }
}))
