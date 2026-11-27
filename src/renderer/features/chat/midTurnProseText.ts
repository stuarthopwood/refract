// Lines of a mid-turn body that carry content: skips blank, code-fence and rule lines (including spaced
// rules such as `* * *`).
export function meaningfulLines(text: string): string[] {
  return text.split(/\r?\n/).filter((candidate) => {
    const trimmed = candidate.trim()
    return trimmed !== '' && !/^(```|~~~|([-*_])(\s*\2){2,}$)/.test(trimmed)
  })
}

// First meaningful line as plain text: drops leading heading/quote/list markers, turns `[text](url)`
// into `text`, and strips only paired emphasis markers (so `update_session_state`, `__init__` and
// `~/repo` survive; `__` pairs only strip around spaced text).
export function firstLineSummary(text: string): string {
  return (meaningfulLines(text)[0] ?? '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|\*|`|~~)(.+?)\1/g, '$2')
    .replace(/__(.+?)__/g, (whole, inner: string) => (/\s/.test(inner) ? inner : whole))
    .trim()
}

// The expanded body adds something over the summary only with a second meaningful line (#1875); a
// long single line is caught by CollapsedLine's overflow check. Not a summary-vs-text comparison:
// the summary strips Markdown markers, so `**done**` differs from its summary yet adds nothing.
export function bodyAddsContent(text: string): boolean {
  return meaningfulLines(text).length > 1
}
