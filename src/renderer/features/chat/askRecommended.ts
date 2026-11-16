import type { AskQuestion } from '../../../shared/model'
import type { AskDraftQuestion } from '@/state/ask-picks-store'

/** OMP sends one question-level index (requests.rs); an out-of-range or negative one counts as none. */
export function recommendedIndex(question: AskQuestion): number | undefined {
  const index = question.recommended
  return index !== undefined && Number.isInteger(index) && index >= 0 && index < question.options.length ? index : undefined
}

export function recommendedLabel(question: AskQuestion): string | undefined {
  const index = recommendedIndex(question)
  return index === undefined ? undefined : question.options[index]?.label
}

/** What opening a question preselects: only a single-choice question's recommended option; a tick box is never ticked for the user. */
export function initialPickFor(question: AskQuestion): string | undefined {
  return question.multi ? undefined : recommendedLabel(question)
}

/** The draft after "Use Recommended": the recommended option picked (ticked, for multiple choice, keeping other ticks), Other dropped on a single choice. */
export function draftAfterUseRecommended(question: AskQuestion, draft: AskDraftQuestion): AskDraftQuestion | undefined {
  const label = recommendedLabel(question)
  if (label === undefined) return undefined
  if (!question.multi) return { ...draft, selectedOptions: [label], otherSelected: false }
  return draft.selectedOptions.includes(label) ? draft : { ...draft, selectedOptions: [...draft.selectedOptions, label] }
}

/** What the card needs to know about the focused element; `AskCard` builds it from `document.activeElement` with `focusProbeOf`. */
export interface FocusProbe {
  tagName: string
  value?: string | undefined
  isContentEditable?: boolean | undefined
  textContent?: string | null | undefined
  /** Inside this card's own Session pane. */
  inOwnSessionPane?: boolean | undefined
  /** Inside a menu, dialog or listbox, which the card must never pull focus out of. */
  inOverlay?: boolean | undefined
}

export function focusProbeOf(active: Element | null, sessionId: string): FocusProbe | null {
  if (!active) return null
  const field = active as Partial<HTMLInputElement & HTMLElement>
  return {
    tagName: active.tagName,
    value: field.value,
    isContentEditable: field.isContentEditable,
    textContent: active.textContent,
    inOwnSessionPane: active.closest(`[data-session-pane="${CSS.escape(sessionId)}"]`) !== null,
    inOverlay: active.closest('[role=menu], [role=dialog], [role=alertdialog], [role=listbox]') !== null
  }
}

/** Only a single-choice question opens on its recommended row: Enter there accepts and advances, which must never tick and submit an unread multiple-choice answer. */
export function opensOnRecommended(question: AskQuestion): boolean {
  return !question.multi && recommendedIndex(question) !== undefined
}

/**
 * A new card takes focus only from `body` or from inside its own Session pane, never from another pane, a menu, a dialog
 * or a listbox, and not from a composer that already holds text (it would swallow the user's next keystroke).
 */
export function shouldTakeInitialFocus(active: FocusProbe | null): boolean {
  if (!active) return true
  const tag = active.tagName.toUpperCase()
  if (tag === 'BODY') return true
  if (active.inOverlay || !active.inOwnSessionPane) return false
  if (tag === 'INPUT' || tag === 'TEXTAREA') return (active.value ?? '').trim().length === 0
  if (active.isContentEditable) return (active.textContent ?? '').trim().length === 0
  return true
}
