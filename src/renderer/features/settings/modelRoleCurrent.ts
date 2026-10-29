// Spec 035 T7: turns a role's stored selector into the text Settings > Models shows at rest.
// Pure (no React), mirroring Refract's own role map in `model_support.rs`
// (`resolve_role_selector`): `@<role>` and `*` (= `@default`) expand one hop through `modelRoles`,
// and an unset `smol` or `slow` inherits `default`. Those two are the only inheritance links
// confirmed by the probe (specs/035-settings-wave2/omp-probe.md); every other unset role is
// reported as `unset` so the UI says OMP picks one automatically.
import type { ModelCatalogEntry, ModelRoleId } from '../../../shared/model'
import { splitThinkingSuffix } from './modelRoleSuffix'

export type RoleValues = Readonly<Record<string, string | undefined>>

export interface RoleCurrent {
  status: 'unset' | 'model' | 'unknown'
  /** The model's friendly name, or the raw selector when `status` is `unknown`. */
  name: string | null
  provider: string | null
  /** The thinking level without its colon (`high`), or null when the value carries none. */
  thinking: string | null
  /** Entries after the first in a comma list. */
  moreCount: number
  /** The whole stored value, set only for a comma list (tooltip text). */
  fullValue: string | null
  /** Where the value came from when it is not the role's own: `Default` or an alias such as `@smol`. */
  via: string | null
}

const INHERITS_DEFAULT: ReadonlySet<string> = new Set(['smol', 'slow'])

function directWithFallback(roles: RoleValues, role: string, own?: string): string | undefined {
  const value = own ?? roles[role]
  if (value) return value
  return INHERITS_DEFAULT.has(role) ? roles.default : undefined
}

const UNSET: RoleCurrent = { status: 'unset', name: null, provider: null, thinking: null, moreCount: 0, fullValue: null, via: null }

export function describeRoleCurrent(role: ModelRoleId, ownValue: string | undefined, roles: RoleValues, catalog: ModelCatalogEntry[] | undefined): RoleCurrent {
  let value = directWithFallback(roles, role, ownValue)
  if (!value) return UNSET
  let via: string | null = !ownValue && !roles[role] ? 'Default' : null

  const aliasTarget = value === '*' ? 'default' : value.startsWith('@') ? value.slice(1) : null
  if (aliasTarget !== null) {
    const hop = aliasTarget === role ? undefined : directWithFallback(roles, aliasTarget)
    if (!hop || hop === '*' || hop.startsWith('@')) {
      return { ...UNSET, status: 'unknown', name: value }
    }
    via = value
    value = hop
  }

  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  const first = entries[0]
  if (!first) return UNSET
  const { base, suffix } = splitThinkingSuffix(first)
  const thinking = suffix ? suffix.slice(1) : null
  const moreCount = entries.length - 1
  const fullValue = moreCount > 0 ? value : null
  const entry = catalog?.find((candidate) => candidate.selector === base)
  if (!entry) return { status: 'unknown', name: base, provider: null, thinking, moreCount, fullValue, via }
  return { status: 'model', name: entry.name, provider: entry.provider, thinking, moreCount, fullValue, via }
}
