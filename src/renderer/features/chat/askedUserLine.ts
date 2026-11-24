// The view model of the Asked-user line (FR-139): the one shape every finished ask is mapped onto,
// and the pure header and digest wording rules, so the component only lays text out.

export type AskedUserStatus = 'answered' | 'answered-by-away' | 'cancelled' | 'timed-out' | 'not-answered'

export interface AskedUserAnswer {
  /** The option label, or the typed text when `other` is set. */
  label: string
  other: boolean
  recommended: boolean
  note?: string
}

export interface AskedUserQuestion {
  prompt: string
  multi: boolean
  /** Empty when the ask ended without an answer for this question. */
  answers: AskedUserAnswer[]
}

export interface AskedUserLineModel {
  status: AskedUserStatus
  questions: AskedUserQuestion[]
}

export const ASKED_USER_TITLE = 'Questions from the agent'
export const NO_ANSWER = 'no answer'

const LABEL_PROMPT_MAX = 80

/** The header after the title: a count while answered, otherwise the status that ended the ask. */
export function askedUserHeader(model: AskedUserLineModel): string {
  const count = model.questions.length
  switch (model.status) {
    case 'answered':
      return `${ASKED_USER_TITLE} · ${count} answered`
    case 'answered-by-away':
      return `${ASKED_USER_TITLE} · ${count} answered by Away Mode`
    case 'cancelled':
      return `${ASKED_USER_TITLE} · cancelled`
    case 'timed-out':
      // A timeout that left nobody an answer must not claim recommended answers were applied.
      return `${ASKED_USER_TITLE} · ${model.questions.some((question) => question.answers.length > 0) ? 'timed out, recommended answers applied' : 'timed out'}`
    case 'not-answered':
      return `${ASKED_USER_TITLE} · not answered`
  }
}

/** The first non-empty line of a prompt, so a multi-line question still digests to one line. */
export function askedUserDigestPrompt(prompt: string): string {
  const first = prompt.split(/\r?\n/).find((line) => line.trim() !== '')
  return (first ?? '').replace(/\s+/g, ' ').trim()
}

/** The text after the digest arrow: the picks and typed text, or `no answer`. */
export function askedUserDigestAnswer(question: AskedUserQuestion): string {
  return question.answers.length > 0 ? question.answers.map((answer) => answer.label).join(', ') : NO_ANSWER
}

/** A note shown in the digest, one per picked option that has one. */
export function askedUserNotes(question: AskedUserQuestion): string[] {
  return question.answers.flatMap((answer) => (answer.note ? [answer.note] : []))
}

export function askedUserHasRecommended(question: AskedUserQuestion): boolean {
  return question.answers.some((answer) => answer.recommended)
}

/** The accessible name of a finished card, from its first question so history cards tell apart. */
export function askedUserLabel(model: AskedUserLineModel): string {
  const first = model.questions[0] ? askedUserDigestPrompt(model.questions[0].prompt) : ''
  if (!first) return ASKED_USER_TITLE
  return `${ASKED_USER_TITLE}: ${first.length > LABEL_PROMPT_MAX ? `${first.slice(0, LABEL_PROMPT_MAX - 1)}...` : first}`
}
