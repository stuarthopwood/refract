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

function findFirstContentLine(lines: string[]): { index: number; stripped: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.length === 0) continue
    if (HEADING_ONLY_GOAL_RE.test(line)) continue
    const stripped = line.replace(HEADING_OR_GOAL_PREFIX_RE, '').trim()
    if (stripped.length === 0) continue
    return { index: i, stripped }
  }
  return null
}

/** First non-empty line of a batch `task()` context, heading markers and "Goal:" stripped, truncated to about 60 characters. */
export function extractContextLabel(context: string): string | null {
  const found = findFirstContentLine(context.split('\n'))
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

/** The three-tier Stage label. */
export function computeStageLabel(context: string | undefined, names: string[]): string | null {
  if (context) {
    const contextLabel = extractContextLabel(context)
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
const LEADING_MARKDOWN_MARKER_RE = /^[#*_`]+\s*/

/** An agent's one-line result preview, shown when its owning Stage is expanded. */
export function extractResultSummary(result: string): string | undefined {
  for (const rawLine of result.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const stripped = line.replace(LEADING_MARKDOWN_MARKER_RE, '').trim()
    if (stripped.length === 0) continue
    return stripped.length <= RESULT_SUMMARY_MAX_CHARS ? stripped : `${stripped.slice(0, RESULT_SUMMARY_MAX_CHARS).trimEnd()}\u2026`
  }
  return undefined
}

export function resolveStageDependencies<
  Item extends { toolCallId: string; specIndex: number },
  Stage extends { stageIndex: number; items: Item[]; dependencies: StageDependency[] }
>(stages: Stage[], nameOf: (item: Item) => string, textOf: (stage: Stage) => string): void {
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
    const text = textOf(stage)
    const seenAgentIds = new Set<string>()
    const dependencies: StageDependency[] = []
    for (const agentId of extractAgentRefs(text)) {
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
