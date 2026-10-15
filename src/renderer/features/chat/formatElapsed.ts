// "28s", "1m 14s", "2h 3m" (T076, FR-046). Split out of `Transcript.tsx` (issue #563) so the
// Subagent chain row and Stage group row (`SubagentChainRow.tsx`) can use the exact same
// formatting without importing back from `Transcript.tsx` (which imports them to render),
// avoiding a circular import the same way `toolStatus.tsx` was split out of `ToolRow.tsx` for.
// Exported for spec 004's Turn time chip too, which must match this exact formatting.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
