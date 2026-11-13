// The combined Role·Model pill (#766 part B, amended item 1): one tab stop that replaces the
// former inert RoleChip + ModelPicker trigger pair. It shows the ROLE only (`[icon] Default`); the
// model name lives in the tooltip (#1878). A Session on a directly picked model shows that model
// name with a pin glyph. While a change is waiting for the next turn it shows the NEW value with a
// small clock glyph.
import { forwardRef, type ComponentProps } from 'react'
import { ClockIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ValueCrossfade } from '@/components/ValueCrossfade'
import { MODEL_NOT_KNOWN } from '@/lib/modelDisplay'
import { friendlyProviderLabel } from '@/lib/providerLabels'
import { useModelRolesStore, useSessionsStore } from '@/state'
import { PICKER_TRIGGER_CLASS } from './pickerShared'
import { chipText, chipTooltip, resolveRoleModelName, roleShown } from './roleModelText'
import { useCyclingRole, useSessionRoles } from './roleCycleStore'

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
    const currentProvider = session?.lastModel ? friendlyProviderLabel(session.lastModel.provider) : null
    const fullName = session?.lastModel ? session.lastModel.name?.trim() || session.lastModel.id : null
    const noun = shown.pinned ? 'Pinned' : shown.roleLabel ? `${shown.roleLabel} role` : null
    const nameModel = queued || shown !== current ? shown.model : fullName
    const name = [noun, nameModel ? `${nameModel} model` : null].filter(Boolean).join(', ') || MODEL_NOT_KNOWN
    const ariaLabel = `${name}${queued ? (stopped ? ', applies when the agent starts' : ', applies next turn') : ''}`
    const tooltip = chipTooltip({ shown, current, queued, stopped, currentProvider })
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
            <shown.Icon aria-hidden className="size-4 shrink-0" />
            <ValueCrossfade className={shown.roleLabel ? 'shrink-0' : 'min-w-0 truncate'} scope={sessionId} value={chipText(shown)} />
            {queued && <ClockIcon aria-hidden data-pending-glyph className="size-4 shrink-0 text-foreground" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    )
  }
)
