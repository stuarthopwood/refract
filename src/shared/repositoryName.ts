export const MAX_REPOSITORY_NAME_LENGTH = 60;

export function validateRepositoryName(trimmed: string): string | undefined {
  if ([...trimmed].length > MAX_REPOSITORY_NAME_LENGTH) {
    return `name too long (max ${MAX_REPOSITORY_NAME_LENGTH} characters)`;
  }
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(trimmed.replace(/[\u200C\u200D]/g, ''))) {
    return 'name must not contain control characters';
  }
  return undefined;
}

export function resolveRepositoryName(trimmed: string, basename: string): string {
  const visible = trimmed.replace(/[\u200C\u200D]/g, '').trim();
  return visible ? trimmed : basename;
}
