// Pure helpers for Stage naming and real `agent://` dependencies (issue #941), split out of
// `groupSubagentStages.ts` so that file stays focused on the grouping pass itself (ADR 0003/
// #806 file-size discipline) -- no `StageGroup` import here, only the primitives
// `groupSubagentStages.ts` already has in hand (names, the shared batch `context`, task text),
// so there is no import-cycle risk either direction.

/** A real reference this Stage's own batch context or a task makes to an agent STARTED BY an
 * earlier Stage in the same turn (issue #941 grill item 5): "Uses: G923Code, G923Arch (Stage
 * 1)". `agentId` is the referenced agent's own `name` (OMP agent ids are name-based, confirmed
 * by `SubagentSummary.id`'s own doc comment in `shared/model.ts`: "the subagent's own `name`").
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
 * else the agents' shared name prefix, else `null` (renderer then shows a bare "Stage N"). */
export function computeStageLabel(context: string | undefined, names: string[]): string | null {
  if (context) {
    const contextLabel = extractContextLabel(context)
    if (contextLabel) return contextLabel
  }
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
const MARKDOWN_MARKER_RE = /[#*_`]+/g

/** An agent's own one-line result preview (issue #941 grill item 7), shown the moment its
 * owning Stage is expanded, with no need to expand the member row itself: the first non-empty
 * line, common inline Markdown markers stripped (plain preview text, not rendered Markdown),
 * truncated to about 120 characters. `undefined` for an empty/whitespace-only result. */
export function extractResultSummary(result: string): string | undefined {
  const firstLine = (result.split('\n')[0] ?? '').trim()
  if (firstLine.length === 0) return undefined
  const stripped = firstLine.replace(MARKDOWN_MARKER_RE, '').trim()
  if (stripped.length === 0) return undefined
  return stripped.length <= RESULT_SUMMARY_MAX_CHARS ? stripped : `${stripped.slice(0, RESULT_SUMMARY_MAX_CHARS).trimEnd()}\u2026`
}
