// FR-140: a tool call's intent reads as "Label: detail". This is a verbatim port of pi-wire 19.1.1's
// `toolIntentLabel`, so Refract and OMP split every intent at the same place.

/** The text before the first colon followed by whitespace or the end (`http://x` stays whole), trimmed; an intent with no such colon, or an empty prefix, is returned in full. */
export function toolIntentLabel(intent: string): string {
  const separator = intent.search(/:(?=\s|$)/)
  return separator > 0 ? intent.slice(0, separator).trim() || intent : intent
}
