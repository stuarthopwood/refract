// The shared role chip (#766 part B, ADR 0003): icon, role name, the model it would use, and
// "current"/"next" text tags. The highlighted chip gets an outline and heavier weight, never
// colour alone.
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function RoleOption({
  id,
  label,
  Icon,
  modelText,
  modelRaw,
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
  modelRaw?: boolean
  current?: boolean
  next?: boolean
  active?: boolean
  disabled?: boolean
  onSelect: () => void
  onHover: () => void
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={current || undefined}
      aria-disabled={disabled || undefined}
      data-active={active}
      onMouseEnter={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (event.button === 0 && !disabled) onSelect()
      }}
      className={cn(
        'flex min-w-0 shrink-0 cursor-default flex-col gap-0.5 rounded-md border border-border px-2 py-1 text-xs',
        active && 'font-medium outline-2 outline-solid outline-offset-[-2px] outline-active-indicator',
        disabled && 'cursor-not-allowed opacity-60'
      )}
    >
      <span className="flex items-center gap-1">
        <Icon aria-hidden className="size-3 shrink-0" />
        {label}
        {current && <span className="font-normal text-muted-foreground">current</span>}
        {next && <span className="font-normal text-muted-foreground">next</span>}
      </span>
      <span className={cn('max-w-32 truncate font-normal text-muted-foreground', modelRaw && 'font-code')}>{modelText}</span>
    </div>
  )
}
