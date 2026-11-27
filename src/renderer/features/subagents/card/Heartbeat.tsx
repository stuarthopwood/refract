/** The view-model owns the bottleneck wording; a blank value means there is nothing to show. */
export function heartbeatText(liveDetail: string | undefined): string | null {
  return liveDetail != null && liveDetail.trim() !== '' ? liveDetail : null
}

// No live region (it would flood screen readers on every frame; the Stage settle is announced elsewhere)
// and no client staleness timer (an invented threshold would be a new product rule). A span, not a `p`, because the
// sub-card button holds it; the dot is `accent-text` (the contrast-checked running tone, #2318 FR-179).
export function Heartbeat({ liveDetail }: { liveDetail: string | undefined }) {
  const text = heartbeatText(liveDetail)
  if (text == null) return null
  return (
    <span className="flex items-start gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="mt-1 size-1.5 shrink-0 animate-pulse rounded-full bg-accent-text motion-reduce:animate-none" />
      <span className="min-w-0 break-words">{text}</span>
    </span>
  )
}
