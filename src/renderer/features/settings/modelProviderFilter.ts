// Issue #1069 (Model roles overhaul): pure provider-filtering and current-value-resolution
// helpers for the provider switch (ADR 0003) and reasoning radios, split out of
// ModelRolesSection.tsx the same way modelRoleSuffix.ts already is (that file's own header: this
// project's vitest.config.ts has no `@/` alias or React/JSX plugin, so pure logic used by a .tsx
// file lives in its own plain .ts module to stay unit-testable).
import type { ModelCatalogEntry } from '../../../shared/model'
import { splitThinkingSuffix } from './modelRoleSuffix'

/** Providers present in `catalog`, in first-seen (catalog) order -- never alphabetised, so the
 * switch's segment order matches whatever order `omp models --kind chat --json` itself returns. */
export function providersInCatalog(catalog: ModelCatalogEntry[] | undefined): string[] {
  const seen = new Set<string>()
  const providers: string[] = []
  for (const entry of catalog ?? []) {
    if (!seen.has(entry.provider)) {
      seen.add(entry.provider)
      providers.push(entry.provider)
    }
  }
  return providers
}

/** Resolves `value` (possibly carrying a trailing `:level` suffix) against the FULL, unfiltered
 * catalog by its suffix-free base selector -- used both to render a trigger whose model belongs
 * to a different provider (decision 3) and to read the reasoning radios' enabled set (decision 4),
 * neither of which is limited to the selected provider's own filtered list. */
export function resolveCatalogEntry(value: string | undefined, catalog: ModelCatalogEntry[] | undefined): ModelCatalogEntry | undefined {
  if (!value) return undefined
  const { base } = splitThinkingSuffix(value)
  return (catalog ?? []).find((entry) => entry.selector === base)
}

/** Decision 2 (no "All" option): the provider switch's own default selection -- the provider of
 * the Default role's current model, resolved against the full catalog. Falls back to the first
 * provider in catalog order when Default is unset or its model is not in the catalog at all (the
 * issue's own documented fallback for this open technical note). Returns `null` only when the
 * catalog itself has no providers yet (nothing to select). */
export function defaultProvider(defaultRoleValue: string | undefined, catalog: ModelCatalogEntry[] | undefined): string | null {
  const providers = providersInCatalog(catalog)
  const firstProvider = providers[0]
  if (firstProvider === undefined) return null
  const entry = resolveCatalogEntry(defaultRoleValue, catalog)
  return entry ? entry.provider : firstProvider
}

/** The selected provider's own models only, in catalog order -- decision 1's "every chat role's
 * dropdown then lists only the selected provider's models". */
export function filterCatalogByProvider(catalog: ModelCatalogEntry[] | undefined, provider: string | null): ModelCatalogEntry[] {
  if (!provider) return []
  return (catalog ?? []).filter((entry) => entry.provider === provider)
}
