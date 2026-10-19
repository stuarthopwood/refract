// Shared role display module (#741 decision 3): role names, provisional per-role icons, and a
// friendly provider map live here ONCE so the composer's role chip (this issue), Settings' colour
// swatches (#714), the icon picker (#717), and the role switcher (#766) all read the exact same
// data instead of four local copies that could drift. `ModelPicker.tsx` is at its 600-line cap
// (facts established before build), so none of this lives there.
//
// Icons are PROVISIONAL (#741 decision 3: "Stuart reviews the icons by eye in the screenshots;
// #717 stays open for his final choice") -- picked for a plausible per-role association, not a
// final design decision. No role colour here (#714 adds it); colour is never the only cue either
// way (WCAG 2.1 AA 1.4.1).
import {
  BrainIcon,
  ClipboardListIcon,
  CircleIcon,
  EyeIcon,
  FeatherIcon,
  GitCommitIcon,
  LifeBuoyIcon,
  ListChecksIcon,
  SlidersHorizontalIcon,
  SproutIcon,
  TurtleIcon,
  UserCheckIcon,
  type LucideIcon
} from 'lucide-react'
import type { ModelRoleId } from '../../shared/model'
import { CHAT_ROLE_DESCRIPTORS } from '../features/settings/ModelRolesSection'

/** The reserved role name OMP itself uses for its own ephemeral retry-fallback transition
 * (`omp://session.md`: "The reserved role `fallback` is ephemeral"), and this app's own sentinel
 * for a Session a direct model pick has pinned (never a role OMP reports back). Neither is a real
 * `ModelRoleId` `omp://models.md` defines, so they are kept as a separate, explicit union rather
 * than widening that type with app-only values. */
export const FALLBACK_ROLE = 'fallback' as const
export const CUSTOM_ROLE = 'custom' as const
export type RoleChipRoleId = ModelRoleId | typeof FALLBACK_ROLE | typeof CUSTOM_ROLE

/** #741 decision 2's exact tooltip wording for a Session OMP has switched off its configured
 * role after repeated failures -- never the user's own saved choice. */
export const FALLBACK_TOOLTIP = 'OMP switched models after repeated failures. This is not your saved choice.'
export const CUSTOM_TOOLTIP = 'A model chosen directly for this session, not through a role.'

/** Chat-role labels, reused verbatim from `ModelRolesSection.tsx`'s own `CHAT_ROLE_DESCRIPTORS`
 * (Settings' single source of truth for role names) so the chip can never show a different name
 * for the same role than Settings does. Model-kind roles (`image`, `web`, `speech`, `dictation`,
 * `judge`) are deliberately absent: `session::model::known_chat_role_list`/`apply_role` only ever
 * resolve this Session's `currentRole` to a CHAT role, so a model-kind id here would be dead code.
 * `Partial` (not a full `Record<ModelRoleId, ...>`): an absent entry is how an unrecognised future
 * role value renders no chip at all (#741: "if the role cannot be established, show nothing
 * rather than a guess"), rather than a runtime crash from a non-exhaustive map. */
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
  default: CircleIcon,
  smol: FeatherIcon,
  slow: TurtleIcon,
  vision: EyeIcon,
  plan: ClipboardListIcon,
  commit: GitCommitIcon,
  tiny: SproutIcon,
  memory: BrainIcon,
  task: ListChecksIcon,
  advisor: UserCheckIcon,
  [CUSTOM_ROLE]: SlidersHorizontalIcon,
  [FALLBACK_ROLE]: LifeBuoyIcon
}

/** Friendly provider names (#741 Part 1: "a small map for the known providers... with the raw id
 * as the fallback; no new dependency"). Built from the fields OMP already reports (`provider`),
 * never by splitting a display string on `/` -- an id such as `openrouter/google/gemini` stays
 * untouched by any caller that uses this map correctly. Shared so the Session details card (this
 * issue), and #714/#717/#766's own provider-aware surfaces, show the exact same provider name. */
const PROVIDER_LABEL: Record<string, string> = {
  'github-copilot': 'GitHub Copilot',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  'azure-openai': 'Azure OpenAI',
  google: 'Google',
  'google-vertex': 'Google Vertex AI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  'llama.cpp': 'llama.cpp',
  'lm-studio': 'LM Studio',
  litellm: 'LiteLLM',
  bedrock: 'Amazon Bedrock',
  local: 'Local',
  apple: 'Apple'
}

/** `provider` -> a friendly display name, or the raw id unchanged when it is not in the map
 * (#741 Part 1: "no name (only an id): show the id as is; do not invent a prettified name" --
 * the same rule applied here to an unrecognised PROVIDER id, not just an unrecognised model
 * name). */
export function friendlyProviderLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider
}

export interface RoleChipDisplay {
  role: RoleChipRoleId
  label: string
  Icon: LucideIcon
  tooltip: string
}

/** The composer role chip's own display rule (#741 decision 1-3), given a `sessions.list()` row's
 * `pinned`/`currentRole` fields (`shared/ipc.ts`'s `SessionSummary`, both optional: Electron never
 * ports this family). `pinned` wins outright -- a Session a direct model pick has pinned shows
 * **Custom** regardless of whatever stale `currentRole` a prior role assignment also left behind
 * (`session::model`'s own `set_model`/`cycle_model`/`handle_switch_text` always clear
 * `current_role` to `None` in the SAME write that sets `pinned`, so this ordering only matters for
 * data from an older registry, pre-dating this field). An unrecognised (or absent) role shows no
 * chip at all, never a guess. */
export function roleChipDisplay(session: { pinned?: boolean; currentRole?: string | null }): RoleChipDisplay | null {
  if (session.pinned) {
    return { role: CUSTOM_ROLE, label: ROLE_LABEL[CUSTOM_ROLE]!, Icon: ROLE_ICON[CUSTOM_ROLE]!, tooltip: ROLE_TOOLTIP[CUSTOM_ROLE]! }
  }
  const role = session.currentRole
  if (!role) return null
  const roleId = role as RoleChipRoleId
  const label = ROLE_LABEL[roleId]
  const Icon = ROLE_ICON[roleId]
  if (!label || !Icon) return null
  return { role: roleId, label, Icon, tooltip: ROLE_TOOLTIP[roleId] ?? label }
}
