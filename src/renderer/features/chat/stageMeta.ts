import type { SubagentRowStatus } from '../subagents/subagentStatus'

/** A reference this Stage makes to an agent started by an earlier Stage in the same turn. */
export interface StageDependency {
  agentId: string
  stageIndex: number
  toolCallId: string
  specIndex: number
}

const LABEL_MAX_CHARS = 60

const HEADING_ONLY_GOAL_RE = /^#{1,6}\s*goal\b:?\s*$/i

const HEADING_OR_GOAL_PREFIX_RE = /^(?:#{1,6}\s*)?(?:goal\b:?\s*)?/i

function truncateLabel(label: string): string {
  if (label.length <= LABEL_MAX_CHARS) return label
  return `${label.slice(0, LABEL_MAX_CHARS).trimEnd()}\u2026`
}

// A line of "Rules (HARD)" boilerplate ends a label search: nothing after it describes the Stage.
const RULES_HARD_RE = /^(?:#{1,6}\s*)?[*_]*rules\s*\(hard\)/i

// Absolute paths through a `worktrees` folder; they swamp a one-line title and mean nothing to a reader.
const WORKTREE_PATH_RE = /(?:[A-Za-z]:[\\/]|~?\/)(?:[^\s`'"]*[\\/])?worktrees[\\/][^\s`'",;)]*/gi

// What is left of "Repo <path>" once the path is gone.
const BARE_PATH_LABEL_RE = /^(?:repo(?:sitory)?|worktree|cwd|path|dir(?:ectory)?)\s*:?\s*$/i

/** `text` with worktree paths removed and the whitespace they leave collapsed. */
export function stripWorktreePaths(text: string): string {
  return text.replace(WORKTREE_PATH_RE, ' ').replace(/\s{2,}/g, ' ').trim()
}

function findFirstContentLine(lines: string[], clean = false): { index: number; stripped: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.length === 0) continue
    if (HEADING_ONLY_GOAL_RE.test(line)) continue
    if (clean && RULES_HARD_RE.test(line)) return null
    let stripped = line.replace(HEADING_OR_GOAL_PREFIX_RE, '').trim()
    if (clean) stripped = stripWorktreePaths(stripped)
    if (stripped.length === 0) continue
    if (clean && BARE_PATH_LABEL_RE.test(stripped)) continue
    return { index: i, stripped }
  }
  return null
}

/** First useful line of a batch `task()` context, heading markers and "Goal:" stripped, truncated to about 60 characters. With `clean` (the default) worktree paths and "Rules (HARD)" boilerplate are dropped first. */
export function extractContextLabel(context: string, clean = true): string | null {
  const found = findFirstContentLine(context.split('\n'), clean)
  if (!found) return null
  return truncateLabel(found.stripped)
}

const GOAL_PREVIEW_MAX_CHARS = 1500

const LEADING_HEADING_MARKER_RE = /^#{1,6}\s*/

function truncateByCodePoint(text: string, maxCodePoints: number): string {
  if (text.length <= maxCodePoints) return text
  const codePoints = Array.from(text)
  if (codePoints.length <= maxCodePoints) return text
  return `${codePoints.slice(0, maxCodePoints).join('').trimEnd()}\u2026`
}

/** A single subagent's own goal when no Stage-level context exists. */
export function extractTaskGoalPreview(task: string): string | null {
  const lines = task.split('\n')
  const found = findFirstContentLine(lines)
  if (!found) return null
  const restLines = lines
    .slice(found.index + 1)
    .map((line) => line.trim().replace(LEADING_HEADING_MARKER_RE, '').trim())
    .filter((line) => line.length > 0)
  const combined = restLines.length > 0 ? `${found.stripped}\n${restLines.join('\n')}` : found.stripped
  return truncateByCodePoint(combined, GOAL_PREVIEW_MAX_CHARS)
}

/** The longest common prefix shared by every name in a Stage with 2+ agents. */
export function sharedNamePrefix(names: string[]): string | null {
  if (names.length < 2) return null
  let prefix = names[0] ?? ''
  for (const name of names.slice(1)) {
    let i = 0
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++
    prefix = prefix.slice(0, i)
    if (prefix.length === 0) break
  }
  return prefix.length >= 2 ? prefix : null
}

/** The three-tier Stage label; `clean: false` keeps the raw first line, for the view-model's `rawLabel`. */
export function computeStageLabel(context: string | undefined, names: string[], options: { clean?: boolean } = {}): string | null {
  if (context) {
    const contextLabel = extractContextLabel(context, options.clean ?? true)
    if (contextLabel) return contextLabel
  }
  if (names.length === 1) return names[0] ?? null
  return sharedNamePrefix(names)
}

/** The visible "Stage N" heading, with "· label" appended when one was computed. */
export function stageHeading(stageIndex: number, label: string | null, forSpeech = false): string {
  if (!label) return `Stage ${stageIndex}`
  return forSpeech ? `Stage ${stageIndex}, ${label}` : `Stage ${stageIndex} \u00b7 ${label}`
}

const AGENT_REF_RE = /agent:\/\/([A-Za-z0-9_.-]+)/g

/** Every distinct `agent://<id>` (and `agent://<id>/<path>`, the path ignored) reference inside a block of text, in first-seen order. */
export function extractAgentRefs(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(AGENT_REF_RE)) {
    const id = match[1]?.replace(/[.-]+$/, '')
    if (id) seen.add(id)
  }
  return [...seen]
}

const RESULT_SUMMARY_MAX_CHARS = 120
// Block markers only: inline emphasis and code survive so the card can render the line as Markdown.
const LEADING_BLOCK_MARKER_RE = /^(?:#{1,6}\s+|>\s*|[-*+]\s+)+/
// OMP wraps a finished agent's output in `<task-result id=".." ...>...</task-result>`; it is transport, never content.
const TASK_RESULT_TAG_RE = /<\/?task-result\b[^>]*>/gi

/** An agent's result text with OMP's `<task-result>` wrapper tags removed. */
export function stripTaskResultWrapper(result: string): string {
  return result.replace(TASK_RESULT_TAG_RE, '').trim()
}

/** An agent's one-line result preview as Markdown (wrapper and block markers removed), shown when its owning Stage is expanded. */
export function extractResultSummary(result: string): string | undefined {
  for (const rawLine of stripTaskResultWrapper(result).split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const stripped = line.replace(LEADING_BLOCK_MARKER_RE, '').trim()
    if (stripped.length === 0) continue
    return stripped.length <= RESULT_SUMMARY_MAX_CHARS ? stripped : `${stripped.slice(0, RESULT_SUMMARY_MAX_CHARS).trimEnd()}\u2026`
  }
  return undefined
}

const INLINE_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g
const INLINE_MARKER_RE = /(\*\*|__|~~|[*`])/g

/** `extractResultSummary` text as plain words, for tooltips, accessible names and rows that do not render Markdown. */
export function plainSummary(markdown: string): string {
  return markdown.replace(INLINE_LINK_RE, '$1').replace(INLINE_MARKER_RE, '')
}

export function resolveStageDependencies<
  Item extends { toolCallId: string; specIndex: number },
  Stage extends { stageIndex: number; items: Item[]; dependencies: StageDependency[] }
>(stages: Stage[], nameOf: (item: Item) => string, refsOf: (stage: Stage) => readonly string[]): void {
  const occurrencesByAgentId = new Map<string, Array<{ stageIndex: number; toolCallId: string; specIndex: number }>>()
  for (const stage of stages) {
    for (const item of stage.items) {
      const agentId = nameOf(item)
      const occurrences = occurrencesByAgentId.get(agentId) ?? []
      occurrences.push({ stageIndex: stage.stageIndex, toolCallId: item.toolCallId, specIndex: item.specIndex })
      occurrencesByAgentId.set(agentId, occurrences)
    }
  }
  for (const stage of stages) {
    const seenAgentIds = new Set<string>()
    const dependencies: StageDependency[] = []
    for (const agentId of refsOf(stage)) {
      const occurrences = occurrencesByAgentId.get(agentId)
      if (!occurrences || seenAgentIds.has(agentId)) continue
      let latest: { stageIndex: number; toolCallId: string; specIndex: number } | undefined
      for (const occurrence of occurrences) {
        if (occurrence.stageIndex >= stage.stageIndex) continue
        if (!latest || occurrence.stageIndex > latest.stageIndex) latest = occurrence
      }
      if (!latest) continue
      seenAgentIds.add(agentId)
      dependencies.push({ agentId, stageIndex: latest.stageIndex, toolCallId: latest.toolCallId, specIndex: latest.specIndex })
    }
    stage.dependencies = dependencies
  }
}

export function stageRollupText(counts: Record<SubagentRowStatus, number>, total: number, isRunning: boolean): string {
  const parts = [isRunning ? `${counts.finished} of ${total} done` : `${counts.finished} done`]
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  if (counts.parked > 0) parts.push(`${counts.parked} parked`)
  return parts.join(', ')
}

/** The unsettled counts only ("1 running, 2 failed"); cancelled is always its own word, never folded into "failed". Zero parts are dropped. */
export function unsettledRollupText(counts: Record<SubagentRowStatus, number>): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  if (counts.parked > 0) parts.push(`${counts.parked} parked`)
  return parts.join(', ')
}
