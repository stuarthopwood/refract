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

/** The composer pill's own wording (#1085, FR-201): "N running" while any agent runs, else the
 * last Stage's "N failed"/"N exited" so a failure is never silent, else empty (no pill). It never
 * says "finished" and never names a cancelled agent (a stop the user asked for). */
export function deriveSubagentPhrase(counts: SubagentCount): string {
  if (counts.running > 0) return `${counts.running} running`
  const parts: string[] = []
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return parts.join(', ')
}

/** True when the pill is showing a failure rather than running work, so it carries an icon as well as text. */
export function isSubagentFailurePhrase(counts: SubagentCount): boolean {
  return counts.running === 0 && (counts.failed > 0 || counts.exited > 0)
}
