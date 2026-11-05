// Parses OMP's `/usage` command reply (a "Usage (4m ago)" header, then one block per provider
// window with an indented "account: N unit used (P% left)" line per account). One place, typed.
export interface UsageRow {
  account: string
  used: string
  unit: string
  /** Percentage of the window still available; null when OMP printed no figure. */
  leftPercent: number | null
}

export interface UsageGroup {
  provider: string
  /** Everything after the provider in OMP's heading, e.g. "Premium Requests (business) - Monthly". */
  window: string
  rows: UsageRow[]
}

export interface UsageReport {
  /** "4m" from "Usage (4m ago)"; null when OMP printed no fetch age. */
  age: string | null
  groups: UsageGroup[]
}

const HEADER = /^Usage(?:\s+\((.+?)\s+ago\))?\s*$/
const ROW = /^\s+(.+?):\s+(-?[\d.,]+)\s*(%|[A-Za-z]+)?\s+used(?:\s+\((-?[\d.]+)%\s+left\))?/

/** Returns null when the text is not a `/usage` reply with at least one usable row. */
export function parseUsageOutput(text: string): UsageReport | null {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line.trimEnd())
  const start = lines.findIndex((line) => line.trim() !== '')
  if (start < 0) return null
  const header = HEADER.exec((lines[start] ?? '').trim())
  if (!header) return null
  const groups: UsageGroup[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue
    const row = ROW.exec(line)
    if (row) {
      const group = groups[groups.length - 1]
      if (!group) return null
      const left = row[4] === undefined ? null : Number.parseFloat(row[4])
      group.rows.push({ account: row[1] ?? '', used: row[2] ?? '', unit: row[3] ?? '', leftPercent: Number.isFinite(left) ? left : null })
    } else if (!/^\s/.test(line)) {
      const [provider = '', ...rest] = line.trim().split(' - ')
      groups.push({ provider, window: rest.join(' - '), rows: [] })
    }
  }
  const filled = groups.filter((group) => group.rows.length > 0)
  return filled.length > 0 ? { age: header[1] ?? null, groups: filled } : null
}

/** First content line of a command reply with fences and Markdown markers stripped, for the collapsed summary. */
export function commandOutputSummary(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^\s*(?:```|~~~).*$/, '')
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+|\|)/, '')
      .replace(/[`*_|]/g, '')
      .trim()
    if (cleaned !== '') return cleaned
  }
  return ''
}
