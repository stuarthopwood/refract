// #525: finds, rewrites and describes fenced code in a composer draft. Pure text in, text out, so
// the textarea wiring stays thin and every rule is unit-tested.
import type { ComposerEdit } from '@/features/chat/composerIndent'
import { languageLabel, resolveOneLineTag } from './codeFenceLanguages'
import { MAX_STYLED_DRAFT_LENGTH } from './markdownLineTokens'

interface FenceOpen {
  char: string
  length: number
  info: string
}

/** A one-line block: `start`..`end` span the whole ```` ```tag body``` ```` text within its line. */
interface LineBlock {
  start: number
  end: number
  tag: string | null
  body: string
}

export interface PreviewBlock {
  tag: string | null
  body: string
  lineCount: number
}

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const BACKTICK_RUN = /`{3,}/g

/** Slash drafts are commands and a long draft is left alone, the same limits as the live Markdown styling. */
function isSnippetDraft(text: string): boolean {
  return text.length <= MAX_STYLED_DRAFT_LENGTH && !text.trimStart().startsWith('/')
}

function openingFence(line: string): FenceOpen | null {
  const match = OPENING_FENCE.exec(line)
  if (!match) return null
  const char = match[1]![0]!
  // CommonMark: a backtick fence's info string cannot hold a backtick, so a closed one-line block is no fence.
  if (char === '`' && match[2]!.includes('`')) return null
  return { char, length: match[1]!.length, info: match[2]!.trim() }
}

function closesFence(line: string, open: FenceOpen): boolean {
  const run = CLOSING_FENCE.exec(line)?.[1]
  return run !== undefined && run[0] === open.char && run.length >= open.length
}

function parseOneLineContent(content: string): Pick<LineBlock, 'tag' | 'body'> | null {
  const trimmed = content.trim()
  if (trimmed === '') return null
  const match = /^(\S+)\s+(\S[\s\S]*)$/.exec(trimmed)
  const tag = match ? resolveOneLineTag(match[1]!, match[2]!)?.tag : undefined
  return tag ? { tag, body: match![2]! } : { tag: null, body: trimmed }
}

/** Every closed one-line block in `line`, opened and closed by a run of exactly three backticks. */
function findLineBlocks(line: string): LineBlock[] {
  const blocks: LineBlock[] = []
  let opener = -1
  for (const run of line.matchAll(BACKTICK_RUN)) {
    if (run[0].length !== 3) {
      opener = -1
      continue
    }
    if (opener === -1) {
      opener = run.index
      continue
    }
    const parsed = parseOneLineContent(line.slice(opener + 3, run.index))
    if (parsed) {
      blocks.push({ start: opener, end: run.index + 3, ...parsed })
      opener = -1
    } else {
      opener = run.index
    }
  }
  return blocks
}

function advanceFence(line: string, open: FenceOpen | null): FenceOpen | null {
  if (open) return closesFence(line, open) ? null : open
  return findLineBlocks(line).length > 0 ? null : openingFence(line)
}

function renderFence(block: LineBlock, eol: string): string {
  return `\`\`\`${block.tag ?? ''}${eol}${block.body}${eol}\`\`\``
}

/** Whether a canonical fence is still open at the start of the line beginning at `lineStart`. */
function fenceOpenBefore(text: string, lineStart: number): boolean {
  if (lineStart === 0) return false
  let open: FenceOpen | null = null
  for (const line of text.slice(0, lineStart - 1).split('\n')) open = advanceFence(line, open)
  return open !== null
}

/**
 * The edit that turns a one-line block ending exactly at `caret` into a three-part fence, or null.
 * The caret lands after the closing fence so typing continues below the block.
 */
export function findFenceRewrite(text: string, caret: number): ComposerEdit | null {
  if (!isSnippetDraft(text) || caret < 3 || caret > text.length) return null
  if (text.slice(caret - 3, caret) !== '```' || text[caret] === '`') return null
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  if (fenceOpenBefore(text, lineStart)) return null
  const segment = text.slice(lineStart, caret)
  const block = findLineBlocks(segment).at(-1)
  if (!block || block.end !== segment.length) return null
  const from = lineStart + block.start
  const lead = segment.slice(0, block.start).trim() === '' ? '' : '\n'
  const trail = text[caret] === '\n' ? '' : '\n'
  const insert = lead + renderFence(block, '\n') + trail
  // An existing newline after the block stays; the caret steps over it onto the next line.
  const caretAfter = from + insert.length + (trail === '' ? 1 : 0)
  return { from, to: caret, insert, selStart: caretAfter, selEnd: caretAfter }
}

/** One line holding one or more one-line blocks as separate lines, or null when it holds none (or is ambiguous). */
function expandLine(line: string, eol: string): string | null {
  const blocks = findLineBlocks(line)
  if (blocks.length === 0) return null
  let out = ''
  let cursor = 0
  for (const block of blocks) {
    const gap = line.slice(cursor, block.start)
    if (gap.includes('```')) return null
    if (gap.trim() !== '') out += (cursor === 0 ? '' : eol) + gap + eol
    else out += cursor === 0 ? gap : eol
    out += renderFence(block, eol)
    cursor = block.end
  }
  const tail = line.slice(cursor)
  if (tail.includes('```')) return null
  return tail.trim() === '' ? out : out + eol + tail
}

/** The send-time pass: one-line blocks become three-part fences; fence-free text and slash commands are returned unchanged and the pass is idempotent. */
export function normaliseFencesForSend(text: string): string {
  if (!text.includes('```') || text.trimStart().startsWith('/')) return text
  const parts = text.split(/(\r?\n)/)
  let open: FenceOpen | null = null
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!
    if (open) {
      open = closesFence(line, open) ? null : open
      continue
    }
    const expanded = expandLine(line, parts[i + 1] || '\n')
    if (expanded === null) open = openingFence(line)
    else parts[i] = expanded
  }
  return parts.join('')
}

/** The last fenced block in the draft, open or closed; an unclosed fence runs to the end like the bubble's rendering. Null when there is none or it is empty. */
export function findPreviewBlock(text: string): PreviewBlock | null {
  if (!text.includes('```') && !text.includes('~~~')) return null
  if (!isSnippetDraft(text)) return null
  const lines = text.split('\n')
  let open: FenceOpen | null = null
  let last: { tag: string | null; bodyStart: number; bodyEnd: number } | null = null
  for (const [index, line] of lines.entries()) {
    if (open && last) {
      if (closesFence(line, open)) {
        last.bodyEnd = index
        open = null
      }
      continue
    }
    open = advanceFence(line, null)
    if (open) last = { tag: open.info.split(/\s+/)[0]?.toLowerCase() || null, bodyStart: index + 1, bodyEnd: lines.length }
  }
  if (!last) return null
  const body = lines.slice(last.bodyStart, last.bodyEnd)
  // The newline the user just typed is not a body line yet.
  if (last.bodyEnd === lines.length && body.at(-1) === '') body.pop()
  return body.join('').trim() === '' ? null : { tag: last.tag, body: body.join('\n'), lineCount: body.length }
}

/** The status line for a preview. The component announces it only when the preview or its language changes, not per keystroke. */
export function describeSnippetAnnouncement(block: PreviewBlock): string {
  return `${languageLabel(block.tag) ?? 'text'} code block, ${block.lineCount} ${block.lineCount === 1 ? 'line' : 'lines'}`
}
