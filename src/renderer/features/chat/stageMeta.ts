// Pure helpers for Stage naming and real `agent://` dependencies (issue #941), split out of
// `groupSubagentStages.ts` so that file stays focused on the grouping pass itself (ADR 0003/
// #806 file-size discipline) -- no `StageGroup` import here, only the primitives
// `groupSubagentStages.ts` already has in hand (names, the shared batch `context`, task text),
// so there is no import-cycle risk either direction.

/** A real reference this Stage's own batch context or a task makes to an agent STARTED BY an
 * earlier Stage in the same turn (issue #941 grill item 5): "Uses: G923Code, G923Arch (Stage
 * 1)". `agentId` is the referenced agent's own `name` (OMP agent ids are name-based, confirmed
 * by `SubagentSummary.id`'s own doc comment in `shared/model.ts`: "the subagent's own `name`").
 */
export interface StageDependency {
  agentId: string
  stageIndex: number
}

const LABEL_MAX_CHARS = 60

/** A line that is ONLY a Markdown heading naming the "Goal" section itself (no real content on
 * that line) -- the common shape of this repo's own `task()` briefs ("# Goal\n<content>"): the
 * heading line itself never names the Stage, so extraction skips to the next non-empty line. */
const HEADING_ONLY_GOAL_RE = /^#{1,6}\s*goal:?\s*$/i

/** A leading Markdown heading marker and/or a "Goal:" prefix on the same line (grill item 3's
 * technical note: "Markdown heading markers and 'Goal:' prefixes stripped"), both optional and
 * matched case-insensitively; always matches (possibly zero characters) so `.replace` is a
 * no-op on a plain-text line with neither. */
const HEADING_OR_GOAL_PREFIX_RE = /^(?:#{1,6}\s*)?(?:goal:?\s*)?/i

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

const AGENT_REF_RE = /agent:\/\/([A-Za-z0-9_.-]+)/g

/** Every distinct `agent://<id>` (and `agent://<id>/<path>`, the path ignored) reference inside
 * a block of text, in first-seen order; issue #941 grill item 5's "Uses:" source scan. */
export function extractAgentRefs(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(AGENT_REF_RE)) {
    const id = match[1]
    if (id) seen.add(id)
  }
  return [...seen]
}
