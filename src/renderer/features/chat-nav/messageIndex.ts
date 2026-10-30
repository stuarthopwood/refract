import type { TranscriptItem } from '../../../shared/model'

export type NavMessageKind = 'user' | 'agent'

export interface NavMessage {
  id: string
  kind: NavMessageKind
  /** Index of the turn this message belongs to, counted as `splitIntoTurns` does. */
  turnIndex: number
  /** First non-blank line, Markdown markers stripped, at most `FIRST_LINE_MAX_CHARS` characters. */
  firstLine: string
  /** Send time of a `user` message; absent when the source carried none. */
  at?: number
  /** Length of the message text in characters. */
  length: number
}

export const FIRST_LINE_MAX_CHARS = 120

const LINE_PREFIX = /^(?:\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+))+/
const FENCE = /^\s*(?:```|~~~)\s*\w*\s*$/

function stripInlineMarkers(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractFirstLine(text: string): string {
  for (const raw of text.split('\n')) {
    if (FENCE.test(raw)) continue
    const line = stripInlineMarkers(raw.replace(LINE_PREFIX, ''))
    if (!line) continue
    const chars = Array.from(line)
    return chars.length > FIRST_LINE_MAX_CHARS ? `${chars.slice(0, FIRST_LINE_MAX_CHARS - 1).join('')}…` : line
  }
  return ''
}

/** The navigable messages of a transcript, in order: every `user` item and every `assistant-text`
 * item with text. Built over the full item list, never the rendered window. A message's id is its
 * item id, which is also its `MessageScrollerItem` id (probe-notes.md). */
export function buildMessageIndex(items: readonly TranscriptItem[]): NavMessage[] {
  const messages: NavMessage[] = []
  let turnIndex = 0
  let turnHasItems = false
  for (const item of items) {
    if (item.kind === 'user') {
      if (turnHasItems) turnIndex += 1
      turnHasItems = true
      messages.push({
        id: item.id,
        kind: 'user',
        turnIndex,
        firstLine: extractFirstLine(item.text),
        ...(item.at > 0 ? { at: item.at } : {}),
        length: item.text.length
      })
      continue
    }
    turnHasItems = true
    if (item.kind === 'assistant-text' && item.text.trim() !== '') {
      messages.push({ id: item.id, kind: 'agent', turnIndex, firstLine: extractFirstLine(item.text), length: item.text.length })
    }
  }
  return messages
}

/** Whether a message's turn is in the part `windowTranscriptTurns` hides. */
export function isTurnWindowedOut(turnIndex: number, hiddenTurnCount: number): boolean {
  return turnIndex < hiddenTurnCount
}

/** "Message N of M" for the polite announcement; `null` when the id is not in the index. */
export function messagePositionAnnouncement(index: readonly NavMessage[], messageId: string): string | null {
  const position = index.findIndex((message) => message.id === messageId)
  return position < 0 ? null : `Message ${position + 1} of ${index.length}`
}

export type StepDirection = 'previous' | 'next'

/** The nearest `user` message before `messageId`: the prompt an agent reply answers; null when none. */
export function precedingUserMessageId(index: readonly NavMessage[], messageId: string): string | null {
  const position = index.findIndex((message) => message.id === messageId)
  for (let i = position - 1; i >= 0; i -= 1) if (index[i]!.kind === 'user') return index[i]!.id
  return null
}

export interface StepTargetInput {
  direction: StepDirection
  /** Navigable message ids in transcript order. */
  orderedIds: readonly string[]
  /** The topmost visible message (the "current" one); `null` when none is known. */
  currentId: string | null
  /** The current message's top minus the viewport top, in pixels (negative: above the viewport). */
  currentTopOffset: number
  tolerancePx?: number
}

export interface StepTarget {
  id: string
  /** `'own-top'` when Previous re-lands on the current message because its top is scrolled out of view. */
  reason: 'own-top' | 'neighbour'
}

/** Previous goes to the nearest message above; if the current message's top is above the viewport
 * top, the first press goes to that message's own top. Next goes to the following message. */
export function resolveStepTarget({ direction, orderedIds, currentId, currentTopOffset, tolerancePx = 2 }: StepTargetInput): StepTarget | null {
  const position = currentId === null ? -1 : orderedIds.indexOf(currentId)
  if (position < 0) return direction === 'next' && orderedIds.length > 0 ? { id: orderedIds[0]!, reason: 'neighbour' } : null
  if (direction === 'previous') {
    if (currentTopOffset < -tolerancePx) return { id: orderedIds[position]!, reason: 'own-top' }
    return position > 0 ? { id: orderedIds[position - 1]!, reason: 'neighbour' } : null
  }
  return position < orderedIds.length - 1 ? { id: orderedIds[position + 1]!, reason: 'neighbour' } : null
}
