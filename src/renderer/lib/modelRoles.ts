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
  SproutIcon,
  TurtleIcon,
  type LucideIcon
} from 'lucide-react'
import type { ModelRoleId } from '../../shared/model'
import { CHAT_ROLE_DESCRIPTORS } from '../features/settings/ModelRolesSection'

/** Reserved role name: OMP's ephemeral `fallback`. */
export const FALLBACK_ROLE = 'fallback' as const
export type RoleChipRoleId = ModelRoleId | typeof FALLBACK_ROLE
/** Chat-role labels, matching Settings' `CHAT_ROLE_DESCRIPTORS`. `Partial` because an unrecognised role has no label here; the chip then shows the raw role name (#741). */
const CHAT_ROLE_LABEL: Partial<Record<ModelRoleId, string>> = Object.fromEntries(
  CHAT_ROLE_DESCRIPTORS.map((entry) => [entry.role, entry.label])
)
export const ROLE_LABEL: Partial<Record<RoleChipRoleId, string>> = {
  ...CHAT_ROLE_LABEL,
  [FALLBACK_ROLE]: 'Fallback'
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
  [FALLBACK_ROLE]: LifeBuoyIcon
}

/** The roles that have a `--role-<tone>` colour token; every other role renders neutral. */
export type RoleTone = 'default' | 'smol' | 'slow' | 'plan'
const ROLE_TONES: Record<string, true> = { default: true, smol: true, slow: true, plan: true }

/** A role's colour tone, or `undefined` when it has no colour token. */
export const roleTone = (role: string): RoleTone | undefined => (Object.hasOwn(ROLE_TONES, role) ? (role as RoleTone) : undefined)
