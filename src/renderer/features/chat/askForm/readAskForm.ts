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
