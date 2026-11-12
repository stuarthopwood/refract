// Kept apart from `check-drag-regions.mjs` so tests can import it without scanning the repo.

// Escapes every regex metacharacter so a JSX tag name is matched literally.
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
