// Issue #700/#701 slice (b): the subagent-count wording `Readouts.tsx`'s `SubagentsReadout` and
// the new Agents hover-focus card (`AgentsCard.tsx`) both need -- extracted so the two never
// phrase one batch's counts two different ways (the same lesson slice (a)'s `todoDerive.ts`
// drew for the Todo pill/card/panel).
import type { SessionReadout } from '../../../../shared/model'

export type SubagentCount = NonNullable<SessionReadout['subagentCount']>

/** Gate fixes 2 finding 7: `finished`/`exited`/`failed` stay separate, never folded together --
 * a turn whose only subagents failed must read "1 failed", never a misleading "0 finished"; a
 * cancelled/aborted subagent (issue #563 decision 15) gets its own word too, never "failed". */
export function deriveSubagentSettledPhrase(counts: SubagentCount): string {
  const parts: string[] = []
  if (counts.finished > 0) parts.push(`${counts.finished} finished`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  return parts.join(', ')
}

/** FR-007/FR-017's own chip wording: the running count while any subagent this turn is still
 * running, else the quiet settled phrase above. */
export function deriveSubagentPhrase(counts: SubagentCount): string {
  if (counts.running > 0) return `${counts.running} subagent${counts.running === 1 ? '' : 's'} running`
  return deriveSubagentSettledPhrase(counts)
}
