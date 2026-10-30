// Shared role names, provisional per-role icons and provider map, so the composer chip, Settings swatches,
// icon picker and role switcher read one source (#741). Icons are provisional (#717); colour is never the only cue.
import {
  ClipboardListIcon,
  DatabaseIcon,
  EyeIcon,
  FeatherIcon,
  GitCommitIcon,
  HouseIcon,
  ImageIcon,
  LifeBuoyIcon,
  ListChecksIcon,
  PinIcon,
  SproutIcon,
  TurtleIcon,
  type LucideIcon
} from 'lucide-react'
import type { ModelRoleId } from '../../shared/model'
import { CHAT_ROLE_DESCRIPTORS } from '../features/settings/ModelRolesSection'

/** Reserved role names: OMP's ephemeral `fallback`, and this app's sentinel for a Session a direct model pick pinned. */
export const FALLBACK_ROLE = 'fallback' as const
export const CUSTOM_ROLE = 'custom' as const
export type RoleChipRoleId = ModelRoleId | typeof FALLBACK_ROLE | typeof CUSTOM_ROLE

/** Tooltip for a Session OMP switched off its configured role after repeated failures (#741). */
export const FALLBACK_TOOLTIP = 'OMP switched models after repeated failures. This is not your saved choice.'
export const CUSTOM_TOOLTIP = 'A model chosen directly for this session, not through a role.'

/** Chat-role labels, matching Settings' `CHAT_ROLE_DESCRIPTORS`. `Partial` so an unrecognised role renders no chip (#741). */
const CHAT_ROLE_LABEL: Partial<Record<ModelRoleId, string>> = Object.fromEntries(
  CHAT_ROLE_DESCRIPTORS.map((entry) => [entry.role, entry.label])
)
const CHAT_ROLE_DESCRIPTION: Partial<Record<ModelRoleId, string>> = Object.fromEntries(
  CHAT_ROLE_DESCRIPTORS.map((entry) => [entry.role, entry.description])
)

export const ROLE_LABEL: Partial<Record<RoleChipRoleId, string>> = {
  ...CHAT_ROLE_LABEL,
  [FALLBACK_ROLE]: 'Fallback',
  [CUSTOM_ROLE]: 'Custom'
}

const ROLE_TOOLTIP: Partial<Record<RoleChipRoleId, string>> = {
  ...CHAT_ROLE_DESCRIPTION,
  [FALLBACK_ROLE]: FALLBACK_TOOLTIP,
  [CUSTOM_ROLE]: CUSTOM_TOOLTIP
}

export const ROLE_ICON: Partial<Record<RoleChipRoleId, LucideIcon>> = {
  default: HouseIcon,
  smol: FeatherIcon,
  slow: TurtleIcon,
  vision: ImageIcon,
  plan: ClipboardListIcon,
  commit: GitCommitIcon,
  tiny: SproutIcon,
  memory: DatabaseIcon,
  task: ListChecksIcon,
  advisor: EyeIcon,
  [CUSTOM_ROLE]: PinIcon,
  [FALLBACK_ROLE]: LifeBuoyIcon
}

export interface RoleChipDisplay {
  role: RoleChipRoleId
  label: string
  Icon: LucideIcon
  tooltip: string
}

/** The composer role chip's display rule: `pinned` wins and shows **Custom**; an unrecognised or absent role shows no chip. */
export function roleChipDisplay(session: { pinned?: boolean; currentRole?: string | null }): RoleChipDisplay | null {
  if (session.pinned) {
    return { role: CUSTOM_ROLE, label: ROLE_LABEL[CUSTOM_ROLE]!, Icon: ROLE_ICON[CUSTOM_ROLE]!, tooltip: ROLE_TOOLTIP[CUSTOM_ROLE]! }
  }
  const role = session.currentRole
  // Custom comes only from `pinned`, never from a role string equal to the sentinel, so it cannot be forged.
  if (!role || role === CUSTOM_ROLE) return null
  const roleId = role as RoleChipRoleId
  const label = ROLE_LABEL[roleId]
  const Icon = ROLE_ICON[roleId]
  if (!label || !Icon) return null
  return { role: roleId, label, Icon, tooltip: ROLE_TOOLTIP[roleId] ?? label }
}
