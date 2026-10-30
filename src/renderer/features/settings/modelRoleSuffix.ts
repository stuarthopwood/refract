// Thinking-suffix helpers, split from `ModelRolesSection.tsx` so they are testable without a `.tsx` import (#455).
// A role value may carry a `:level` suffix, so picking a (suffix-free) catalog selector carries the existing suffix over.
const THINKING_SUFFIX_RE = /:(off|minimal|low|medium|high|xhigh|max|auto|inherit)$/;

/** Splits a role selector into its base and an optional trailing `:level` suffix. */
export function splitThinkingSuffix(selector: string): { base: string; suffix: string | null } {
  const match = selector.match(THINKING_SUFFIX_RE);
  if (!match) return { base: selector, suffix: null };
  return { base: selector.slice(0, -match[0].length), suffix: match[0] };
}

/** The value to save when `pickedValue` is chosen for a role currently set to `currentValue`: carries the existing thinking suffix over. */
export function applyThinkingSuffixCarryOver(pickedValue: string, currentValue: string | undefined): string {
  if (!currentValue) return pickedValue;
  const current = splitThinkingSuffix(currentValue);
  const picked = splitThinkingSuffix(pickedValue);
  return current.suffix && !picked.suffix ? `${pickedValue}${current.suffix}` : pickedValue;
}
