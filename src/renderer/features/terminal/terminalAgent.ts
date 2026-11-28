import { toast } from 'sonner'
import { useDraftStore } from '@/state/draft-store'
import { OUTPUT_CAP_BYTES } from '../../../shared/terminalLimits'

// The only code that turns terminal output into a message, and only on the developer's click (spec 144 FR-018 to
// FR-021, SC-006). Nothing here runs on its own.

const KIB = 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface OutputForAgent {
  text: string
  truncated: boolean
  totalBytes: number
}

/** Prefixes every line with `> ` so the composer shows the output as a quotation, not as the developer's own words. */
export function quoteBlock(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** Keeps the end of `text` within `maxBytes`: the latest lines are the ones a developer is asking about. */
export function capTail(text: string, maxBytes: number): OutputForAgent {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return { text, truncated: false, totalBytes: bytes.length }
  const kept = decoder.decode(bytes.subarray(bytes.length - maxBytes))
  // Cutting inside a multi-byte character leaves one replacement character at the start.
  return { text: kept.replace(/^\uFFFD+/, ''), truncated: true, totalBytes: bytes.length }
}

/** "96 KiB", rounded up so the figure never claims less than was cut. */
function formatKiB(bytes: number): string {
  return `${Math.ceil(bytes / KIB)} KiB`
}

export const truncationNotice = (totalBytes: number): string => `[Truncated: last ${OUTPUT_CAP_BYTES / KIB} KiB of ${formatKiB(totalBytes)} shown]`

/** A fence one backtick longer than any run inside the text, so the output cannot close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

export function buildAskMessage(output: OutputForAgent): string {
  const fence = fenceFor(output.text)
  const lines = ['Can you help with this terminal output?', '']
  if (output.truncated) lines.push(truncationNotice(output.totalBytes), '')
  lines.push(fence, output.text.replace(/\n+$/, ''), fence)
  return lines.join('\n')
}

/** Puts the selection in the composer as a quoted block. Never sends. */
export function addToChat(sessionId: string, selection: string): boolean {
  if (selection.trim() === '') return false
  const store = useDraftStore.getState()
  const current = store.bySession[sessionId]?.text ?? ''
  const separator = current === '' ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  store.setText(sessionId, `${current}${separator}${quoteBlock(selection)}\n\n`)
  toast('Added the selection to the message box')
  return true
}

/** Sends the selection, or else the recent command's output, as one ordinary chat turn. */
export async function askAgent(sessionId: string, tabId: string, selection: string): Promise<void> {
  let output: OutputForAgent
  if (selection.trim() !== '') {
    output = capTail(selection, OUTPUT_CAP_BYTES)
  } else {
    const read = await window.refract.terminal.readOutput(tabId, 'recent-command')
    if (!read.ok) {
      toast.error(read.error.message)
      return
    }
    output = read.value
  }
  if (output.text.trim() === '') {
    toast('There is no terminal output to send yet')
    return
  }
  const sent = await window.refract.chat.send(sessionId, buildAskMessage(output))
  if (!sent.ok) {
    toast.error(sent.error.message)
    return
  }
  if (output.truncated) toast(`Only the last ${OUTPUT_CAP_BYTES / KIB} KiB of the output was sent`)
}
