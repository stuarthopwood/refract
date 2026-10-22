// The combined Role·Model pill (#766 part B, amended item 1): one tab stop that replaces the
// former inert RoleChip + ModelPicker trigger pair. It shows `[role icon] Default · Sonnet 5.5`
// (pinned: pin glyph and "Pinned · Sonnet 5.5"), and while a change is waiting for the next turn
// it shows the NEW value with a small clock glyph. The model text truncates first; below ~400px
// of composer width (`@container` on the composer row) only the role shows and the model moves
// into the tooltip.
import { forwardRef, type ComponentProps } from 'react'
import { ClockIcon, CpuIcon, PinIcon, type LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CUSTOM_ROLE, ROLE_ICON, ROLE_LABEL, type RoleChipRoleId } from '@/lib/modelRoles'
import { friendlyProviderLabel } from '@/lib/providerLabels'
import { useModelRolesStore, useSessionsStore } from '@/state'
import { PICKER_TRIGGER_CLASS } from './pickerShared'
import { resolveRoleModelName, shortModelName } from './roleModelText'
import { useCyclingRole, useSessionRoles } from './roleCycleStore'

interface Shown {
  pinned: boolean
  roleLabel: string | null
  Icon: LucideIcon
  model: string | null
}

function roleShown(role: string | null | undefined, pinned: boolean, model: string | null): Shown {
  if (pinned) return { pinned: true, roleLabel: 'Pinned', Icon: PinIcon, model }
  const known = role && role !== CUSTOM_ROLE ? (role as RoleChipRoleId) : null
  return { pinned: false, roleLabel: known ? (ROLE_LABEL[known] ?? known) : null, Icon: (known && ROLE_ICON[known]) || CpuIcon, model }
}

/** "Default · Sonnet 5.5" (the vendor prefix is dropped from the visible text only). */
export function shownText(shown: Shown): string {
  const model = shown.model ? shortModelName(shown.model) : null
  return [shown.roleLabel, model].filter(Boolean).join(' · ') || 'Model not known yet'
}

/** The current and the next-turn values the pill, tooltip and switcher all read. */
export function useRoleModelDisplay(sessionId: string) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const cycling = useCyclingRole(sessionId)
  const roles = useSessionRoles(sessionId)
  const catalog = useModelRolesStore((s) => s.catalogs.chat)
  const pending = session?.pendingSelection
  const lastModel = session?.lastModel
  const currentModelName = lastModel ? lastModel.name?.trim() || lastModel.id : null
  const current = roleShown(session?.currentRole, Boolean(session?.pinned), currentModelName)
  const nextRole = cycling ?? pending?.role ?? null
  let shown = current
  if (nextRole) shown = roleShown(nextRole, false, resolveRoleModelName(nextRole, roles, catalog))
  else if (pending?.model) {
    const match = (catalog ?? []).find((entry) => entry.provider === pending.model!.provider && entry.id === pending.model!.modelId)
    shown = roleShown(null, true, match?.name ?? pending.model.modelId)
  }
  const queued = Boolean(pending?.role || pending?.model)
  return { session, current, shown, queued, nextRole, stopped: session?.status === 'stopped' }
}

export const RoleModelPill = forwardRef<HTMLButtonElement, ComponentProps<'button'> & { sessionId: string; busy?: boolean }>(
  function RoleModelPill({ sessionId, busy, className, ...rest }, ref) {
    const { session, current, shown, queued, stopped } = useRoleModelDisplay(sessionId)
    const fullModel = session?.lastModel
      ? `${friendlyProviderLabel(session.lastModel.provider)}/${session.lastModel.name?.trim() || session.lastModel.id}`
      : null
    const fullName = session?.lastModel ? session.lastModel.name?.trim() || session.lastModel.id : null
    const noun = shown.pinned ? 'Pinned' : shown.roleLabel ? `${shown.roleLabel} role` : null
    const nameModel = queued || shown !== current ? shown.model : fullName
    const name = [noun, nameModel ? `${nameModel} model` : null].filter(Boolean).join(', ') || 'Model not known yet'
    const ariaLabel = `${name}${queued ? (stopped ? ', applies when the agent starts' : ', applies next turn') : ''}`
    const nowText = shownText(current)
    const tooltip = queued
      ? `${stopped ? 'Applies when the agent starts' : 'Applies on next turn'}. Now: ${nowText}.`
      : `${shownText(shown)}${fullModel ? ` (${fullModel})` : ''}. Ctrl+R cycles roles.`
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            {...rest}
            ref={ref}
            type="button"
            data-role-model-pill
            aria-label={ariaLabel}
            aria-busy={busy || undefined}
            aria-describedby={undefined}
            className={cn(PICKER_TRIGGER_CLASS, 'max-w-80 min-w-0 shrink', className)}
          >
            <shown.Icon aria-hidden className="size-3 shrink-0" />
            <span className="shrink-0">{shown.roleLabel ?? (shown.model ? shortModelName(shown.model) : 'Model not known yet')}</span>
            {shown.roleLabel && shown.model && (
              <span className="flex min-w-0 gap-1 @max-[400px]:hidden">
                <span aria-hidden>·</span>
                <span className="truncate">{shortModelName(shown.model)}</span>
              </span>
            )}
            {queued && <ClockIcon aria-hidden data-pending-glyph className="size-3 shrink-0 text-foreground" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    )
  }
)
