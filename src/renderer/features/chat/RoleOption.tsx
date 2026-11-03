// The shared role chip (#766 part B, ADR 0003): icon, role name and "current"/"next" text tags on
// the role's tint and border. The model it would use lives in the tooltip and the accessible
// description. The current role takes the active border; the highlighted chip gets a focus ring and
// heavier weight, never colour alone.
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RoleTone } from '@/lib/modelRoles'

// Full class strings so Tailwind's scanner sees them.
const TONE_BORDER: Record<RoleTone, string> = {
  default: 'border-role-default',
  smol: 'border-role-smol',
  slow: 'border-role-slow',
  plan: 'border-role-plan'
}
const TONE_FILL: Record<RoleTone, string> = {
  default: 'bg-role-default-tint',
  smol: 'bg-role-smol-tint',
  slow: 'bg-role-slow-tint',
  plan: 'bg-role-plan-tint'
}

export function RoleOption({
  id,
  label,
  Icon,
  modelText,
  tone,
  current,
  next,
  active,
  disabled,
  onSelect,
  onHover
}: {
  id: string
  label: string
  Icon: LucideIcon
  modelText: string
  /** The role's colour token; omit for a role without one, which stays neutral. */
  tone?: RoleTone
  current?: boolean
  next?: boolean
  active?: boolean
  disabled?: boolean
  onSelect: () => void
  onHover: () => void
}) {
  const modelId = `${id}-model`
  return (
    <div
      id={id}
      role="option"
      title={modelText}
      aria-selected={current || undefined}
      aria-disabled={disabled || undefined}
      aria-describedby={modelId}
      data-active={active}
      onMouseEnter={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (event.button === 0 && !disabled) onSelect()
      }}
      className={cn(
        'flex min-w-0 shrink-0 cursor-default items-center gap-1 rounded-md border px-2 py-1 text-xs',
        current ? 'border-active-indicator' : tone ? TONE_BORDER[tone] : 'border-border',
        tone ? TONE_FILL[tone] : 'bg-popover',
        active && 'font-medium ring-2 ring-ring',
        disabled && 'cursor-not-allowed opacity-60'
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      {/* #1208 SC-005: an invisible medium-weight copy reserves the highlighted width, so moving
          the highlight never resizes the chip or shifts its neighbours. */}
      <span className="grid *:col-start-1 *:row-start-1">
        <span>{label}</span>
        <span aria-hidden className="invisible font-medium">{label}</span>
      </span>
      {current && <span className="font-normal text-muted-foreground">current</span>}
      {next && <span className="font-normal text-muted-foreground">next</span>}
      <span id={modelId} className="sr-only">{modelText}</span>
    </div>
  )
}
