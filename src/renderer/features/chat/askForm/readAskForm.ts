import { parseAskHtml, type AskFormField } from './parseAskHtml'

/** The ask tool's `args.html` as a field list, or `null` when it carries none the card can build. */
export function readAskForm(args: unknown): AskFormField[] | null {
  if (!args || typeof args !== 'object' || !('html' in args)) return null
  return parseAskHtml(args.html)
}

const isTimedOutFlag = (record: unknown): boolean => !!record && typeof record === 'object' && 'timedOut' in record && record.timedOut === true

/** Whether the finished ask's details say OMP gave up waiting, at the top level or on any per-question result. */
export function isAskTimedOut(details: unknown): boolean {
  if (isTimedOutFlag(details)) return true
  if (!details || typeof details !== 'object' || !('results' in details) || !Array.isArray(details.results)) return false
  return details.results.some(isTimedOutFlag)
}

export interface AskFormAnswer {
  name: string
  question: string
  /** Display text; an empty saved answer reads "No selection". */
  answer: string
}

const LABEL_QUESTION_MAX = 80

/** The accessible name of a finished card, from its first question so history cards tell apart. */
export function askCardLabel(answers: readonly AskFormAnswer[]): string {
  const first = answers[0]?.question.replace(/\s+/g, ' ').trim()
  if (!first) return 'Questions from the agent'
  return `Questions from the agent: ${first.length > LABEL_QUESTION_MAX ? `${first.slice(0, LABEL_QUESTION_MAX - 1)}…` : first}`
}

export const NO_SELECTION = 'No selection'

/** The finished ask's `details.answers` as read-only rows, or `null` when it carries none. */
export function readAskFormAnswers(details: unknown): AskFormAnswer[] | null {
  if (!details || typeof details !== 'object' || !('answers' in details) || !Array.isArray(details.answers)) return null
  const rows: AskFormAnswer[] = []
  for (const entry of details.answers as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const { name, question, answer } = entry as Record<string, unknown>
    const text = typeof answer === 'string' ? answer.trim() : ''
    const label = typeof question === 'string' && question.trim() ? question : typeof name === 'string' ? name : ''
    if (!label) continue
    rows.push({ name: typeof name === 'string' ? name : label, question: label, answer: text || NO_SELECTION })
  }
  return rows.length > 0 ? rows : null
}
