// Pure helpers in a plain .ts module: vitest.config.ts has no `@/` alias or JSX plugin (#1069).
import type { ModelCatalogEntry } from '../../../shared/model'
import { splitThinkingSuffix } from './modelRoleSuffix'

/** Providers in `catalog`, in first-seen order (not alphabetised). */
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

/** Resolves `value` (maybe with a `:level` suffix) against the full catalog by its suffix-free selector. */
export function resolveCatalogEntry(value: string | undefined, catalog: ModelCatalogEntry[] | undefined): ModelCatalogEntry | undefined {
  if (!value) return undefined
  const { base } = splitThinkingSuffix(value)
  return (catalog ?? []).find((entry) => entry.selector === base)
}

/** Default role's provider, else the first provider; `null` when the catalog has no providers. */
export function defaultProvider(defaultRoleValue: string | undefined, catalog: ModelCatalogEntry[] | undefined): string | null {
  const providers = providersInCatalog(catalog)
  const firstProvider = providers[0]
  if (firstProvider === undefined) return null
  const entry = resolveCatalogEntry(defaultRoleValue, catalog)
  return entry ? entry.provider : firstProvider
}

/** The selected provider's models only, in catalog order. */
export function filterCatalogByProvider(catalog: ModelCatalogEntry[] | undefined, provider: string | null): ModelCatalogEntry[] {
  if (!provider) return []
  return (catalog ?? []).filter((entry) => entry.provider === provider)
}
