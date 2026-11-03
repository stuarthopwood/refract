// Percent-of-context-window maths for the compaction thresholds (#1553).
import type { ModelCatalogEntry } from '../../../../shared/model'
import { parsePercent } from '../../../../shared/tokenGuard'
import { splitThinkingSuffix } from '../modelRoleSuffix'

export const MIN_PERCENT = 1
export const MAX_PERCENT = 99

/** Window of the Default role's first model; null when it is unset, an alias, or not in the catalogue. */
export function defaultRoleWindow(roles: Readonly<Record<string, string | undefined>>, catalog: ModelCatalogEntry[] | undefined): number | null {
  const first = roles.default?.split(',')[0]?.trim()
  if (!first) return null
  return windowFor(catalog, splitThinkingSuffix(first).base)
}

export function windowFor(catalog: ModelCatalogEntry[] | undefined, selector: string): number | null {
  const window = catalog?.find((entry) => entry.selector === selector)?.contextWindow
  return typeof window === 'number' && window > 0 ? window : null
}

export const tokensToPercent = (tokens: number, window: number): number =>
  Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round((tokens * 100) / window)))

export const percentToTokens = (percent: number, window: number): number => Math.round((percent * window) / 100)

/** Reads a stored `"N%"` entry (0 when malformed). */
export const parsePercentEntry = parsePercent
