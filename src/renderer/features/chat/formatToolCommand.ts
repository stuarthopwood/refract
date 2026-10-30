import type { TranscriptItem } from '../../../shared/model'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex -- deliberately matching C0 controls/DEL/bidi overrides to strip them
const UNSAFE_CHARS_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g

export function sanitizeLines(raw: string): string[] {
  return raw
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(ANSI_PATTERN, '').replace(UNSAFE_CHARS_PATTERN, '').trim())
    .filter((line) => line.length > 0)
}

function stringField(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function commandRowText(item: ToolItem): string {
  if (item.tool === 'bash') {
    const lines = item.target.split(/\r\n|\n|\r/)
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    const firstNonEmptyLine = sanitizeLines(nonEmptyLines[0] ?? '')[0] ?? ''
    return `${firstNonEmptyLine}${nonEmptyLines.length > 1 ? ' …' : ''}`
  }
  if (item.tool === 'grep') {
    const pattern = sanitizeLines(item.target)[0] ?? ''
    const path = stringField(item.args, 'path')
    const sanitizedPath = path ? sanitizeLines(path)[0] : undefined
    return sanitizedPath ? `"${pattern}" ${sanitizedPath}` : `"${pattern}"`
  }
  return item.target
}
