// Issue #480 point 5 validation rules, shared (main's IPC handler and the renderer's rename
// input both need `MAX_REPOSITORY_NAME_LENGTH`) and unit-testable without spinning up Electron:
// "trimmed, not empty, a sensible maximum (for example 60 characters), no control characters."
// An empty (after trimming) name is not an error here -- the caller resets it to the folder's own
// basename instead (point 4).
export const MAX_REPOSITORY_NAME_LENGTH = 60;

/** Quality-gate fix (security-auditor/test-reviewer, Medium, 2026-10-08): counted in code points
 * (`[...trimmed].length`), not UTF-16 code units (`.length`) -- a plain `.length` cap lets through
 * at most 30 characters outside the BMP (each a surrogate pair) before silently rejecting a name
 * half the visible length of an ASCII one, and miscounts combining-mark sequences the same way.
 * Returns an error message for an invalid non-empty name, or `undefined` when `trimmed` is
 * acceptable to store as-is (an empty string is always acceptable -- see above). */
export function validateRepositoryName(trimmed: string): string | undefined {
  if ([...trimmed].length > MAX_REPOSITORY_NAME_LENGTH) {
    return `name too long (max ${MAX_REPOSITORY_NAME_LENGTH} characters)`;
  }
  // Quality-gate fix (security-auditor/test-reviewer, Medium, 2026-10-08): the old
  // `/[\x00-\x1f\x7f]/` only rejected C0 controls and DEL. `\p{Cc}` (Unicode "Control" category)
  // also catches C1 controls (\x80-\x9f); `\p{Cf}` ("Format") catches bidi overrides/isolates
  // (U+202A-202E, U+2066-2069) and zero-width/format characters (U+200B-200F, U+FEFF) that could
  // otherwise spoof the displayed name (it renders in the header, aria-labels, and dialog titles);
  // U+2028/U+2029 (line/paragraph separator) are outside both categories and listed explicitly.
  // Quality-gate fix (cycle 2, 2026-10-08): U+200C (ZWNJ) and U+200D (ZWJ) are excluded from
  // that -- both are also `\p{Cf}`, but they are not spoofing/invisible-text characters, they
  // are REQUIRED for legitimate text: emoji ZWJ sequences (e.g. family or profession emoji) and
  // joining letters in Persian, Arabic and several Indic scripts. Stripped before the test, not
  // added as a second alternation, since JS regex character classes cannot express "this set
  // minus these two code points" directly.
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(trimmed.replace(/[\u200C\u200D]/g, ''))) {
    return 'name must not contain control characters';
  }
  return undefined;
}

/** Point 4: clearing the field and committing resets the display name back to the folder's own
 * basename. `basename` is passed in (`path.basename(repository.path)`) rather than computed here,
 * so this stays a pure string function with no `node:path` dependency.
 *
 * Quality-gate fix (cycle 3, 2026-10-08): U+200C/U+200D (ZWNJ/ZWJ) are invisible on their own --
 * exempted above from the control-character rejection because they are REQUIRED to join
 * legitimate text (emoji sequences, Persian/Indic scripts), but a name made of ONLY these
 * (pasted, or typed by mistake, e.g. a bare ZWJ) is exactly as blank as an all-whitespace one to
 * anyone who ever reads the stored name back, and must reset to the basename the same way, not
 * silently store an invisible name. A name where a joiner sits between real characters (the
 * legitimate case) is unaffected: `visible` only goes empty when EVERY code point is one of
 * these two.
 *
 * Quality-gate fix (cycle 5, 2026-10-08, test-reviewer, Medium): a name mixing a joiner with
 * ordinary (non-leading/trailing-only) whitespace, e.g. `'\u200D \u200D'` or `'\u200D\u00A0'`,
 * still slipped through -- `trimmed` had already had its OWN leading/trailing whitespace removed
 * by the caller before a joiner ever appeared at the edge, so stripping just the joiners left an
 * internal space (or a lone U+00A0 non-breaking space) that reads as truthy. The extra `.trim()`
 * here catches exactly that: it also removes U+00A0 (ECMAScript's `trim()` follows the Unicode
 * White_Space property, which includes it), so a bare non-breaking space or a joiner-flanked
 * space both correctly fall back to the basename too. */
export function resolveRepositoryName(trimmed: string, basename: string): string {
  const visible = trimmed.replace(/[\u200C\u200D]/g, '').trim();
  return visible ? trimmed : basename;
}
