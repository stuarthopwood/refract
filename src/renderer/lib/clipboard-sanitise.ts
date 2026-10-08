// Pure clipboard-text sanitiser (security review, PR #597 cycles 1-4), split out of
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
//   turning a one-click Copy into a one-click Trojan Source exploit. U+200E/U+200F (LRM/RLM) and
//   U+061C (ALM) are kept: legitimate Arabic/Hebrew text relies on them and none of them reorders
//   surrounding text the way the override/isolate controls do.
// - The deprecated invisible format controls U+206A-U+206F (deprecated bidi/shaping controls) and
//   U+FFF9-U+FFFB (interlinear annotation controls) are stripped too: no legitimate use in code or
//   tool output, and they render as nothing, same invisible-payload shape as the bidi controls
//   above.
// - Unicode tag characters (U+E0000-U+E007F) are stripped ("ASCII smuggling"): they render as
//   nothing in Chromium but survive an unsanitised copy, letting agent-influenced output carry an
//   invisible ASCII payload into whatever the user pastes into next. The one legitimate use of
//   this block is a well-formed emoji subdivision-flag tag sequence (a black-flag base U+1F3F4
//   followed by 1-7 lowercase-ASCII tag letters/digits and a U+E007F cancel tag, e.g. the Scotland
//   flag) -- that exact sequence is kept whole; any other tag character, including a bare,
//   malformed, uppercase-tag or wrong-base one, is stripped individually (never reassembled into
//   a different valid sequence).
// - Unpaired (lone) surrogates (U+D800-U+DFFF not part of a valid pair) are ALSO stripped, in the
//   same pass as the tag characters (cycle 4 fix): a string can smuggle a tag character past the
//   tag-stripping regex by splitting it across two lone surrogates with a real, matchable tag
//   character in between -- e.g. `'\uDB40' + '\u{E0001}' + '\uDC69'` has the valid tag char
//   `U+E0001` (itself the pair `\uDB40\uDC01`) stripped correctly, but the SURVIVING lone
//   `\uDB40` and `\uDC69` then sit adjacent to each other and themselves form a brand-new valid
//   surrogate pair, `U+E0069` -- another tag character the single regex pass never re-scans for.
//   Stripping every unpaired surrogate in the same pass removes both lone halves before they can
//   become adjacent, closing the splice. (With the `u` flag, `[\uD800-\uDFFF]` in a character
//   class matches only a surrogate that ISN'T part of a well-formed pair -- the engine treats a
//   real pair as one non-BMP code point, never matching its two halves against a BMP-range class.)
//
// Accepted, documented residual (not stripped, deliberately): a handful of other invisible or
// format characters have a real use and are left alone -- variation selectors VS1-16 (U+FE00-
// U+FE0F) and VS17-256 (U+E0100-U+E01EF, emoji/Mongolian/Phags-pa presentation), ZWSP (U+200B),
// U+2060-U+2064 (word joiner and invisible math operators), a mid-text BOM (U+FEFF, legitimate at
// the start of a file but otherwise just a zero-width marker), U+180E (Mongolian vowel separator)
// and the Hangul filler characters (U+115F, U+1160, U+3164, U+FFA0). None of these reorders or
// hides a *different* payload the way the bidi/tag ranges above do; they are the
// homoglyph/identifier-spoofing class (CVE-2021-42694), not the Trojan Source/ASCII-smuggling
// classes this sanitiser targets, and stripping them would change real program semantics and
// Mongolian/Phags-pa/Hangul text.
export function sanitiseForClipboard(text: string): string {
  return text
    .replace(/\r(?!\n)/g, "\n")
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u206A-\u206F\uFFF9-\uFFFB]/g, "")
    .replace(
      /(\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,7}\u{E007F})|[\u{E0000}-\u{E007F}\uD800-\uDFFF]/gu,
      (_m, flag: string | undefined) => flag ?? "",
    )
}
