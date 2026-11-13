import type { AskQuestion } from '../../../shared/model'
import type { AskDraftQuestion } from '@/state/ask-picks-store'

/** OMP sends one question-level index (requests.rs); an out-of-range or negative one counts as none. */
export function recommendedIndex(question: AskQuestion): number | undefined {
  const index = question.recommended
  return index !== undefined && index >= 0 && index < question.options.length ? index : undefined
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

export interface FocusProbe {
  tagName: string
  value?: string | undefined
  isContentEditable?: boolean | undefined
  textContent?: string | null | undefined
}

/** A card that arrives while the user is mid-sentence in the composer must not take focus and swallow their next keystroke. */
export function shouldTakeInitialFocus(active: FocusProbe | null): boolean {
  if (!active) return true
  const tag = active.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA') return (active.value ?? '').trim().length === 0
  if (active.isContentEditable) return (active.textContent ?? '').trim().length === 0
  return true
}
