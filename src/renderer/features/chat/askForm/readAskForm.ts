import { isFrameField, parseAskHtml, type AskFormFrameField } from './parseAskHtml'

/**
 * The ask tool's `args.html` as per-field-card fields, or `null` when it carries none the card can build.
 * A select or typed input exists only in a v19 whole form, so a form holding one keeps today's per-field path.
 */
export function readAskForm(args: unknown): AskFormFrameField[] | null {
  if (!args || typeof args !== 'object' || !('html' in args)) return null
  const fields = parseAskHtml(args.html)
  return fields?.every(isFrameField) ? fields : null
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
  /** The saved answer text; empty when the group was left unanswered. */
  answer: string
}

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
    rows.push({ name: typeof name === 'string' ? name : label, question: label, answer: text })
  }
  return rows.length > 0 ? rows : null
}
