// Issue #480 point 5 validation rules, pulled out of the IPC handler so they are unit-testable
// without spinning up Electron: "trimmed, not empty, a sensible maximum (for example 60
// characters), no control characters." An empty (after trimming) name is not an error here -- the
// caller resets it to the folder's own basename instead (point 4).
export const MAX_REPOSITORY_NAME_LENGTH = 60;

/** Returns an error message for an invalid non-empty name, or `undefined` when `trimmed` is
 * acceptable to store as-is (an empty string is always acceptable -- see above). */
export function validateRepositoryName(trimmed: string): string | undefined {
  if (trimmed.length > MAX_REPOSITORY_NAME_LENGTH) {
    return `name too long (max ${MAX_REPOSITORY_NAME_LENGTH} characters)`;
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
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
