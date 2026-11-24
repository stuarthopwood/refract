// Maps a finished `ask` / `refract_ask` tool row onto the Asked-user line's model (FR-139); a field a
// source lacks is left out, never invented. The HTML-form ask has its own reader.

import type { AskQuestion, TranscriptItem } from '../../../shared/model'
import { recommendedLabels } from './askRecommended'
import type { AskedUserAnswer, AskedUserLineModel, AskedUserQuestion, AskedUserStatus } from './askedUserLine'
import { isAskTimedOut, readAskForm, readAskFormAnswers } from './askForm/readAskForm'
import type { AskFormField } from './askForm/parseAskHtml'
import { readNumberedAnswers } from './readNumberedAnswers'

type AskToolItem = Extract<TranscriptItem, { kind: 'tool' }>

const CANCELLED_RESULT = /^The developer cancelled the questions\./

interface Pick {
  label: string
  recommended: boolean
}

interface Note {
  option: string
  text: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function readNotes(value: unknown): Note[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const { option, text } = asRecord(entry) ?? {}
    return typeof option === 'string' && typeof text === 'string' ? [{ option, text }] : []
  })
}

function readOptions(value: unknown): AskQuestion['options'] {
  return (Array.isArray(value) ? value : []).flatMap((option) => {
    if (typeof option === 'string') return [{ label: option }]
    const record = asRecord(option)
    return typeof record?.label === 'string' ? [{ label: record.label, recommended: record.recommended === true }] : []
  })
}

/** The questions of the call's args, native or `refract_ask`; a missing `id` falls back to its position, as the result lists do. */
function readQuestions(args: unknown): AskQuestion[] {
  const record = asRecord(args)
  const list = Array.isArray(record?.questions) && record.questions.length > 0 ? record.questions : typeof record?.question === 'string' && record.question ? [record] : []
  return list.flatMap((entry, index) => {
    const question = asRecord(entry)
    if (!question) return []
    return [
      {
        id: typeof question.id === 'string' ? question.id : String(index),
        question: typeof question.question === 'string' ? question.question : '',
        options: readOptions(question.options),
        multi: question.multi === true,
        ...(typeof question.recommended === 'number' ? { recommended: question.recommended } : {})
      }
    ]
  })
}

/** The status that ended the ask without an answer, when one did. */
function endedStatus(item: AskToolItem): Extract<AskedUserStatus, 'cancelled' | 'not-answered'> | undefined {
  if (item.status === 'error' || item.status === 'cancelled' || (item.output && CANCELLED_RESULT.test(item.output))) return 'cancelled'
  return item.status === 'interrupted' ? 'not-answered' : undefined
}

/** Picks and typed text to answers; a note rides on the pick it names, or on the first answer when that option is not among them. */
function toAnswers(picks: Pick[], typed: string, notes: Note[]): AskedUserAnswer[] {
  const answers: AskedUserAnswer[] = picks.map((pick) => ({ label: pick.label, other: false, recommended: pick.recommended }))
  if (typed.trim()) answers.push({ label: typed.trim(), other: true, recommended: false })
  for (const note of notes) {
    const target = answers.find((answer) => !answer.other && answer.label === note.option)
    const text = target ? note.text : `${note.option}: ${note.text}`
    const holder = target ?? answers[0]
    if (holder) holder.note = holder.note ? `${holder.note} ${text}` : text
  }
  return answers
}

interface ReadAnswers {
  answers: AskedUserAnswer[][]
  byAway: boolean
}

/** Structured `details.results`, one entry per question matched by id. */
function fromResults(questions: AskQuestion[], results: unknown[]): ReadAnswers {
  const byId = new Map<string, Record<string, unknown>>()
  for (const entry of results) {
    const result = asRecord(entry)
    if (typeof result?.id === 'string') byId.set(result.id, result)
  }
  return {
    byAway: results.some((entry) => asRecord(entry)?.byAway === true),
    answers: questions.map((question) => {
      const result = byId.get(question.id)
      if (!result) return []
      const recommended = recommendedLabels(question)
      const picks = strings(result.selectedOptions).map((label) => ({ label, recommended: recommended.includes(label) }))
      return toAnswers(picks, typeof result.customInput === 'string' ? result.customInput : '', readNotes(result.notes))
    })
  }
}

/** The numbered text of saved history, when the details carry no structured results. */
function fromNumberedText(questions: AskQuestion[], output: string | undefined): ReadAnswers | undefined {
  const numbered = readNumberedAnswers(output, questions.map((question) => ({ question: question.question, options: question.options.map((option) => option.label) })))
  if (!numbered) return undefined
  return { byAway: numbered.byAway, answers: numbered.answers.map((answer) => toAnswers(answer.picks, answer.typed, answer.notes)) }
}

/** The oldest native-ask shape: one question, answered in top-level details or only in the result text. */
function fromLegacy(question: AskQuestion | undefined, details: Record<string, unknown> | undefined, output: string | undefined): AskedUserAnswer[] {
  const recommended = question ? recommendedLabels(question) : []
  const answers = toAnswers(strings(details?.selectedOptions).map((label) => ({ label, recommended: recommended.includes(label) })), typeof details?.customInput === 'string' ? details.customInput : '', [])
  const text = output?.trim()
  return answers.length === 0 && text ? [{ label: text, other: false, recommended: false }] : answers
}

function readAnswers(item: AskToolItem, questions: AskQuestion[]): ReadAnswers {
  const details = asRecord(item.details)
  if (Array.isArray(details?.results) && details.results.length > 0) return fromResults(questions, details.results)
  const numbered = fromNumberedText(questions, item.output)
  if (numbered) return numbered
  return { byAway: false, answers: questions.length === 1 ? [fromLegacy(questions[0], details, item.output)] : questions.map(() => []) }
}

function statusOf(item: AskToolItem, byAway: boolean): AskedUserStatus {
  return endedStatus(item) ?? (isAskTimedOut(item.details) ? 'timed-out' : byAway ? 'answered-by-away' : 'answered')
}

/** `refract_ask` results and the rows of old native-ask transcripts. */
function askResultModel(item: AskToolItem): AskedUserLineModel {
  const questions = readQuestions(item.args)
  const { answers, byAway } = readAnswers(item, questions)
  const ended = endedStatus(item) !== undefined
  return {
    status: statusOf(item, byAway),
    questions: questions.map((question, index): AskedUserQuestion => ({ prompt: question.question, multi: question.multi, answers: ended ? [] : (answers[index] ?? []) }))
  }
}

/** An HTML-form ask: its saved rows carry only a name, the question and one answer text, so there are no notes or recommendations and no per-pick split. */
function askFormModel(item: AskToolItem, fields: AskFormField[]): AskedUserLineModel {
  const ended = endedStatus(item) !== undefined
  const rows = readAskFormAnswers(item.details)
  const questions: AskedUserQuestion[] = rows
    ? rows.map((row) => ({ prompt: row.question, multi: false, answers: !ended && row.answer ? [{ label: row.answer, other: false, recommended: false }] : [] }))
    : fields.map((field) => ({ prompt: field.question, multi: false, answers: [] }))
  return { status: statusOf(item, false), questions }
}

/** The Asked-user line's model for a finished ask row, whichever source wrote it. */
export function askedUserModel(item: AskToolItem): AskedUserLineModel {
  const fields = readAskForm(item.args)
  return fields ? askFormModel(item, fields) : askResultModel(item)
}
