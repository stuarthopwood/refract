// Issue #455: pure thinking-suffix helpers, extracted from `ModelRolesSection.tsx` so they can be
// unit tested without importing a `.tsx` file (this project's `vitest.config.ts` has no `@/` path
// alias or React/JSX plugin configured -- those live only in the main `electron.vite.config.ts`).
//
// `omp://models.md` "Role aliases and settings": chat selectors may carry a trailing thinking
// suffix from this fixed vocabulary. A role value with one (e.g.
// `anthropic/claude-sonnet-4-5:high` -- confirmed the live default on this machine's real
// profile, every chat role carries one) never matches a catalog `selector` verbatim; picking a
// fresh catalog selector (always suffix-free) now carries the role's EXISTING suffix over rather
// than silently dropping it (quality-gate remediation, test-reviewer MEDIUM).
const THINKING_SUFFIX_RE = /:(off|minimal|low|medium|high|xhigh|max|auto|inherit)$/;

/** Splits a role selector into its base and an optional trailing `:level` suffix. */
export function splitThinkingSuffix(selector: string): { base: string; suffix: string | null } {
  const match = selector.match(THINKING_SUFFIX_RE);
  if (!match) return { base: selector, suffix: null };
  return { base: selector.slice(0, -match[0].length), suffix: match[0] };
}

/** Computes the value to actually save when the user picks `pickedValue` from the catalog for a
 * role whose current value is `currentValue` (may be `undefined`, i.e. unset): carries over the
 * current value's thinking suffix onto the freshly picked (always suffix-free) catalog selector,
 * so picking a different model never silently drops the user's existing thinking level. */
export function applyThinkingSuffixCarryOver(pickedValue: string, currentValue: string | undefined): string {
  if (!currentValue) return pickedValue;
  const current = splitThinkingSuffix(currentValue);
  const picked = splitThinkingSuffix(pickedValue);
  return current.suffix && !picked.suffix ? `${pickedValue}${current.suffix}` : pickedValue;
}
