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
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(trimmed)) {
    return 'name must not contain control characters';
  }
  return undefined;
}

/** Point 4: clearing the field and committing resets the display name back to the folder's own
 * basename. `basename` is passed in (`path.basename(repository.path)`) rather than computed here,
 * so this stays a pure string function with no `node:path` dependency. */
export function resolveRepositoryName(trimmed: string, basename: string): string {
  return trimmed || basename;
}
