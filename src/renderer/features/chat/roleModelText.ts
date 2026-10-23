// Pure text helpers shared by the combined Role·Model pill, the switcher and the Ctrl+R cycle
// (#766 part B). No state, no IPC.
import type { ModelCatalogEntry } from '../../../shared/model'
import { ROLE_FALLBACK_LABEL } from '../settings/ModelRolesSection'

const ROLE_FALLBACK: Partial<Record<string, string>> = ROLE_FALLBACK_LABEL

export interface RoleListEntry {
  role: string
  model: string | null
}

/** The visible pill text drops the vendor prefix ("Claude Sonnet 5.5" -> "Sonnet 5.5"); the
 * accessible name keeps the full name, so the visible text stays inside it (WCAG 2.5.3). */
export function shortModelName(name: string): string {
  return name.replace(/^claude\s+/i, '')
}

/** A role's `model` field is a raw `provider/id` selector (#741); looks it up in the loaded
 * catalog for a friendly name. `raw: true` marks the selector fallback (render monospace).
 * A role with neither a model nor a documented fallback (`hasFallback: false`) cannot be
 * applied: selecting it would resolve to nothing. */
export function friendlyRoleModel(
  role: string,
  selector: string | null,
  catalog: readonly ModelCatalogEntry[] | undefined
): { text: string; raw: boolean; hasFallback: boolean } {
  if (!selector) {
    const fallback = ROLE_FALLBACK[role]
    return fallback
      ? { text: `Inherited (${fallback})`, raw: false, hasFallback: true }
      : { text: 'Inherited (no fallback)', raw: false, hasFallback: false }
  }
  const match = (catalog ?? []).find((entry) => `${entry.provider}/${entry.id}` === selector)
  return match ? { text: match.name, raw: false, hasFallback: true } : { text: selector, raw: true, hasFallback: true }
}

/** The catalog name of the model a role would use now; an unset role resolves through its
 * documented fallback role (`ROLE_FALLBACK_LABEL`). `null` while the catalog or role list has
 * not loaded, or when nothing resolves. */
export function resolveRoleModelName(
  role: string,
  roles: readonly RoleListEntry[],
  catalog: readonly ModelCatalogEntry[] | undefined
): string | null {
  let entry = roles.find((candidate) => candidate.role === role)
  if (entry && entry.model === null) {
    const fallback = ROLE_FALLBACK[role]?.toLowerCase()
    entry = fallback ? roles.find((candidate) => candidate.role === fallback) : undefined
  }
  if (!entry?.model) return null
  return (catalog ?? []).find((candidate) => `${candidate.provider}/${candidate.id}` === entry.model)?.name ?? null
}

/** Roles the Ctrl+R cycle and the switcher can actually apply, in `listRoles` order. */
export function applicableRoles(roles: readonly RoleListEntry[]): RoleListEntry[] {
  return roles.filter((entry) => entry.model !== null || Boolean(ROLE_FALLBACK[entry.role]))
}
