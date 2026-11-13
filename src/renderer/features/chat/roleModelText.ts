// Pure text helpers shared by the combined Role·Model pill, the switcher and the Ctrl+R cycle
// (#766 part B). No state, no IPC.
import { CpuIcon, PinIcon, type LucideIcon } from 'lucide-react'
import type { ModelCatalogEntry } from '../../../shared/model'
import { MODEL_NOT_KNOWN } from '../../lib/modelDisplay'
import { FALLBACK_ROLE, ROLE_ICON, ROLE_LABEL, type RoleChipRoleId } from '../../lib/modelRoles'
import { ROLE_FALLBACK_LABEL } from '../settings/ModelRolesSection'

const ROLE_FALLBACK: Partial<Record<string, string>> = ROLE_FALLBACK_LABEL

/** The sentence for a Session OMP moved off its configured role (#741): in the tooltip and the pill's accessible name. */
export const FALLBACK_NOTE = 'The agent switched models after repeated failures. This is not your saved choice.'

export interface RoleListEntry {
  role: string
  model: string | null
}

/** What the pill shows for one value: the role (or a pin when the model was picked directly), its
 * icon and the model name behind it. */
export interface Shown {
  pinned: boolean
  role: string | null
  roleLabel: string | null
  Icon: LucideIcon
  model: string | null
}

/** A pinned Session claims no role, whatever role OMP last reported, so it shows the pin glyph. */
export function roleShown(role: string | null | undefined, pinned: boolean, model: string | null): Shown {
  if (pinned) return { pinned: true, role: null, roleLabel: null, Icon: PinIcon, model }
  const known = role ? (role as RoleChipRoleId) : null
  return { pinned: false, role: known, roleLabel: known ? (ROLE_LABEL[known] ?? known) : null, Icon: (known && ROLE_ICON[known]) || CpuIcon, model }
}

/** Drops the vendor prefix ("Claude Sonnet 5.5" -> "Sonnet 5.5") from model names shown as visible
 * text; the accessible name keeps the full name, so the visible text stays inside it (WCAG 2.5.3). */
export function shortModelName(name: string): string {
  return name.replace(/^claude\s+/i, '')
}

/** The chip's visible text: the role alone, or the model name for a Session whose model was picked
 * directly (no role). The role's model moves to the tooltip (#1878). */
export function chipText(shown: { roleLabel: string | null; model: string | null }): string {
  return shown.roleLabel ?? (shown.model ? shortModelName(shown.model) : MODEL_NOT_KNOWN)
}

/** Role and model together, "Default · Sonnet 5.5", for the places that name both (the "Now:" line,
 * the switcher's "Keep current"); a pinned Session has no role, so it reads the model alone. */
export function shownText(shown: { roleLabel: string | null; model: string | null }): string {
  const model = shown.model ? shortModelName(shown.model) : null
  return [shown.roleLabel, model].filter(Boolean).join(' · ') || MODEL_NOT_KNOWN
}

/** The new value a queued change leads with, noun first: "Slow (Opus 5.5)", "Pinned (Opus 5.5)". */
function queuedValue(shown: Shown): string {
  const model = shown.model ? shortModelName(shown.model) : null
  if (shown.pinned) return model ? `Pinned (${model})` : 'Pinned model'
  if (shown.roleLabel) return model ? `${shown.roleLabel} (${model})` : shown.roleLabel
  return model ?? 'New model'
}

export interface ChipTooltipInput {
  shown: Shown
  current: Shown
  queued: boolean
  stopped: boolean
  /** Friendly provider label of the Session's current model, or null before one is known. */
  currentProvider: string | null
}

/** The chip tooltip, where the role's model name shows (#1878). The full name and provider are added
 * only while `shown` is the current value: a queued or mid-cycle model has no known provider yet, and
 * naming the current one there would not match what Ctrl+R is about to apply. */
export function chipTooltip({ shown, current, queued, stopped, currentProvider }: ChipTooltipInput): string {
  if (queued) return `${queuedValue(shown)} applies ${stopped ? 'when the agent starts' : 'on next turn'}. Now: ${shownText(current)}.`
  const isCurrent = shown === current
  const model = shown.model ? (isCurrent ? shown.model : shortModelName(shown.model)) : null
  const via = isCurrent && model && currentProvider ? ` via ${currentProvider}` : ''
  if (shown.pinned) return `${model ? `Pinned to ${model}${via}.` : 'Pinned to a model not known yet.'} Ctrl+R returns to a role.`
  const lead = shown.roleLabel ? `${shown.roleLabel} role: ${model ?? MODEL_NOT_KNOWN}${via}.` : `${model ?? MODEL_NOT_KNOWN}${via}.`
  return `${lead}${shown.role === FALLBACK_ROLE ? ` ${FALLBACK_NOTE}` : ''} Ctrl+R cycles roles.`
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
