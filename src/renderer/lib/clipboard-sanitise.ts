// Pure clipboard-text sanitiser (security review, PR #597 cycles 1-2), split out of
// copy-button.tsx so it can be unit-tested with vitest's plain `node` environment (vitest.config.ts)
// without pulling in React/Radix/the renderer state barrel just to exercise a regex. The visible
// transcript text is never touched -- this only sanitises what a Copy button's click handler
// actually writes to the OS clipboard.
//
// - A lone CR (not part of CRLF) becomes LF first, so the copy keeps the same line breaks the
//   rendered `<pre>` shows (Shiki and the DOM both treat `\r\n` as one break; a lone `\r` left
//   as-is would otherwise survive as an invisible extra line break once pasted into a terminal
//   without bracketed paste, e.g. older conhost).
// - C0 controls other than tab/LF/CR, DEL, and the C1 range (U+0080-U+009F) are stripped:
//   agent-written tool output and fence content are attacker-influenceable (prompt injection, a
//   malicious repo's command output), and an invisible escape sequence or bracketed-paste
//   terminator copied verbatim could break out of a terminal's bracketed paste on later use
//   ("pastejacking"). Vertical tab (U+000B) and form feed (U+000C) are deliberately KEPT: both
//   are real bytes in source text (e.g. C, Emacs Lisp and Python files use `\f` as a page break),
//   and neither can break a paste.
// - Bidirectional override and isolate characters (U+202A-U+202E, U+2066-U+2069) are stripped:
//   the Trojan Source pattern (CVE-2021-42574) uses these to make Chromium *display* code in an
//   order that differs from the order a shell or an unaware editor actually runs/saves it in,
//   turning a one-click Copy into a one-click Trojan Source exploit. U+200E/U+200F (LRM/RLM) are
//   kept: legitimate Arabic/Hebrew text relies on them and neither reorders surrounding text the
//   way the override/isolate controls do.
export function sanitiseForClipboard(text: string): string {
  return text
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
}
