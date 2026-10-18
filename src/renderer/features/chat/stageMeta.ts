// Pure helpers for Stage naming and real `agent://` dependencies (issue #941), split out of
// `groupSubagentStages.ts` so that file stays focused on the grouping pass itself (ADR 0003/
// #806 file-size discipline) -- no `StageGroup` import here, only the primitives
// `groupSubagentStages.ts` already has in hand (names, the shared batch `context`, task text),
// so there is no import-cycle risk either direction.
import type { SubagentRowStatus } from '../subagents/subagentStatus'

/** A real reference this Stage's own batch context or a task makes to an agent STARTED BY an
 * earlier Stage in the same turn (issue #941 grill item 5): "Uses: G923Code, G923Arch (Stage
 * 1)". `agentId` is the referenced agent's own `name` (OMP agent ids are name-based; each
 * caller's own `nameOf` passed to `resolveStageDependencies` below supplies the real one --
 * `SubagentSummary.id` is `${toolCallId}:${nameOrTask}`, gate-fix, NEVER the bare name alone).
 * `toolCallId`/`specIndex` (gate round 1 fix) are the matched item's own pair -- the same
 * correlation key `ChainAgentEntry`/`SubagentSummary` already use -- so a name repeated across
 * two Stages resolves to the exact matched agent, not an ambiguous name-only lookup. */
export interface StageDependency {
  agentId: string
  stageIndex: number
  toolCallId: string
  specIndex: number
}

const LABEL_MAX_CHARS = 60

/** A line that is ONLY a Markdown heading naming the "Goal" section itself (no real content on
 * that line) -- the common shape of this repo's own `task()` briefs ("# Goal\n<content>"): the
 * heading line itself never names the Stage, so extraction skips to the next non-empty line. */
const HEADING_ONLY_GOAL_RE = /^#{1,6}\s*goal\b:?\s*$/i

/** A leading Markdown heading marker and/or a "Goal:" prefix on the same line (grill item 3's
 * technical note: "Markdown heading markers and 'Goal:' prefixes stripped"), both optional and
 * matched case-insensitively; always matches (possibly zero characters) so `.replace` is a
 * no-op on a plain-text line with neither. `\b` after "goal" (gate round 1 fix) so a real word
 * starting with "goal" (e.g. "Goaltending") is never mistaken for the section-heading prefix. */
const HEADING_OR_GOAL_PREFIX_RE = /^(?:#{1,6}\s*)?(?:goal\b:?\s*)?/i

function truncateLabel(label: string): string {
  if (label.length <= LABEL_MAX_CHARS) return label
  return `${label.slice(0, LABEL_MAX_CHARS).trimEnd()}\u2026`
}

/** First non-empty line of a batch `task()` call's own `context` argument, Markdown heading
 * markers and "Goal:" prefixes stripped, truncated to about 60 characters (issue #941 grill
 * item 3). Plain text only: `context` is untrusted agent-authored text, never rendered as
 * Markdown here. `null` when every line is empty or a bare "# Goal" heading with nothing after
 * it on every line (the whole context body was blank). */
export function extractContextLabel(context: string): string | null {
  for (const rawLine of context.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (HEADING_ONLY_GOAL_RE.test(line)) continue
    const stripped = line.replace(HEADING_OR_GOAL_PREFIX_RE, '').trim()
    if (stripped.length === 0) continue
    return truncateLabel(stripped)
  }
  return null
}

/** The longest common prefix shared by every name in a Stage with 2+ agents (issue #941 grill
 * item 3's "no context" fallback, "Stage 1 · G923" from `G923Code`/`G923Tests`/`G923Security`/
 * `G923A11y`/`G923Arch`): `null` when fewer than 2 names are given (a single agent's own full
 * name is not a "shared" prefix) or the names share fewer than 2 leading characters (not
 * meaningful as a label). */
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

/** The three-tier Stage label (issue #941 grill item 3): the batch context's own first line,
 * else the agents' shared name prefix (or, gate round 2 fix, item 1: a SOLO Stage's own one
 * agent name -- a one-agent Stage still gets "the Stage treatment", never a bare "Stage N"
 * just because there is no "shared" prefix to compute with only one name), else `null` (a
 * multi-agent Stage with no context and no shared prefix shows a bare "Stage N"). */
export function computeStageLabel(context: string | undefined, names: string[]): string | null {
  if (context) {
    const contextLabel = extractContextLabel(context)
    if (contextLabel) return contextLabel
  }
  if (names.length === 1) return names[0] ?? null
  return sharedNamePrefix(names)
}

/** The visible "Stage N" heading, with "· label" appended when a label was computed (issue
 * #941 grill item 3); `forSpeech` (gate round 1 fix, item 6) swaps the "·" for a comma so an
 * `aria-label`/`triggerAriaLabel` built from this never has a screen reader read the glyph
 * aloud -- the VISIBLE text always uses the "·" form regardless of this flag. */
export function stageHeading(stageIndex: number, label: string | null, forSpeech = false): string {
  if (!label) return `Stage ${stageIndex}`
  return forSpeech ? `Stage ${stageIndex}, ${label}` : `Stage ${stageIndex} \u00b7 ${label}`
}

const AGENT_REF_RE = /agent:\/\/([A-Za-z0-9_.-]+)/g

/** Every distinct `agent://<id>` (and `agent://<id>/<path>`, the path ignored) reference inside
 * a block of text, in first-seen order; issue #941 grill item 5's "Uses:" source scan. Gate
 * round 1 fix: a trailing `.`/`-` is stripped from the captured id (the regex's own char class
 * accepts both for a genuine mid-id character, but a reference at the end of a sentence --
 * "see agent://G923Code." -- must not fold the closing punctuation into the id). */
export function extractAgentRefs(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(AGENT_REF_RE)) {
    const id = match[1]?.replace(/[.-]+$/, '')
    if (id) seen.add(id)
  }
  return [...seen]
}

const RESULT_SUMMARY_MAX_CHARS = 120
// Gate round 2 fix (item 7): anchored at the START of the line only (`^`) -- the un-anchored,
// global original stripped a marker character ANYWHERE in the line, corrupting an inline
// `snake_case` identifier (every `_` removed) or a mid-sentence `*`/backtick. A trailing
// marker (e.g. the closing `**` of "**Bold**") is accepted as a smaller cosmetic artifact.
const LEADING_MARKDOWN_MARKER_RE = /^[#*_`]+\s*/

/** An agent's own one-line result preview (issue #941 grill item 7), shown the moment its
 * owning Stage is expanded, with no need to expand the member row itself: the first NON-EMPTY
 * line (gate round 2 fix: a blank first line no longer blanks the whole preview, it scans
 * forward the same way `extractContextLabel` already does), its own leading Markdown marker
 * stripped, truncated to about 120 characters. `undefined` when every line is blank. */
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

/** Gate round 1 fix (issue #941 part 2, item 2, HIGH): the "latest earlier occurrence wins"
 * dependency algorithm, extracted so `groupSubagentStages.ts` (the chat's own `StageGroup[]`)
 * and `groupSubagentPanelStages.ts` (the panel's own `PanelStageGroup[]`) call ONE shared
 * implementation instead of two independent copies. `nameOf` resolves an item's own real agent
 * identity (the chat passes `item => item.name`; the panel passes `item => item.nameOrTask` --
 * NEVER `item => item.id`, which is `${toolCallId}:${nameOrTask}`, gate-fix, not a bare name).
 * `textOf` receives the WHOLE stage (not a per-item string) so each caller's own closure reads
 * whatever text source it has -- the chat's own batch `context` plus every item's `task`; the
 * panel's own items' `nameOrTask` alone (it has no `context`). Mutates `stage.dependencies` in
 * place once every Stage's final `stageIndex` is known, matching the pre-extraction behaviour
 * exactly. */
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

/** Gate round 1 fix (issue #941 part 2, item 6, MEDIUM): the "N done"/"N of M done, M failed"
 * roll-up wording (issue #941 grill item 3), extracted from `SubagentChainRow.tsx`'s own
 * `stageRunningSummary`/`stageSettleSummary` so the Subagents panel's own Stage header states
 * the identical text, never a second hand-written copy that could drift -- `counts.failed`/
 * `cancelled`/`exited` are ALWAYS stated regardless of `isRunning`, so a Stage with one member
 * still running and another already failed never reads as a bare "running" with the failure
 * hidden underneath it. */
export function stageRollupText(counts: Record<SubagentRowStatus, number>, total: number, isRunning: boolean): string {
  const parts = [isRunning ? `${counts.finished} of ${total} done` : `${counts.finished} done`]
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return parts.join(', ')
}
