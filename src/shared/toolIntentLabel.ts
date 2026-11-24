// FR-140: a tool call's intent reads as "Label: detail". OMP shows only the label on its own rows,
// so Refract ports its `toolIntentLabel` and trailing-dot trim here, once, for every surface.

/** The text before the first colon that is followed by whitespace or the end, so `http://x` stays whole. */
function labelBeforeColon(intent: string): string {
  const separator = intent.search(/:(?=\s|$)/)
  return separator > 0 ? intent.slice(0, separator).trim() || intent : intent
}

/** The brief label of `intent`; an intent with no qualifying colon, or an empty result, is returned in full. */
export function toolIntentLabel(intent: string): string {
  const full = intent.trim()
  const label = labelBeforeColon(full).trim().replace(/\s*\.+$/, '').trim()
  return label || full
}
