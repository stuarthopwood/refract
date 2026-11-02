import { BellOffIcon, ListChecksIcon, MessagesSquareIcon, MousePointerClickIcon, type LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ValueCrossfade } from '@/components/ValueCrossfade'
import { useSessionsStore } from '@/state'
import { cn } from '@/lib/utils'
import { PICKER_TRIGGER_CLASS } from './pickerShared'
import type { WorkingMode } from '../../../shared/workingMode'

interface ModeItem {
  value: WorkingMode
  label: string
  hint: string
  icon: LucideIcon
}

const MODE_ITEMS: ModeItem[] = [
  { value: 'interactive', label: 'Interactive', hint: 'Normal turns; you answer questions.', icon: MousePointerClickIcon },
  { value: 'plan', label: 'Plan mode', hint: 'Plans first; switches when the turn ends.', icon: ListChecksIcon },
  { value: 'grill', label: 'Grill mode', hint: 'Interviews you one question at a time before any code edits.', icon: MessagesSquareIcon },
  { value: 'away', label: 'Away mode', hint: 'Answers questions itself; denies approvals after 5 minutes.', icon: BellOffIcon }
]

/** Per-Session working-mode picker; Approval mode stays app-wide in its own pill. */
export function WorkingModeMenu({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((state) => state.sessions.find((candidate) => candidate.id === sessionId))
  const currentMode = session?.workingMode ?? 'interactive'
  const pendingMode = session?.workingModePending ?? null
  const current = MODE_ITEMS.find((item) => item.value === currentMode) ?? MODE_ITEMS[0]!
  const CurrentIcon = current.icon
  const pendingItem = pendingMode ? MODE_ITEMS.find((item) => item.value === pendingMode) : undefined
  const pendingLabel = pendingItem ? `${pendingItem.label} when the turn ends` : null

  function handleSelect(mode: WorkingMode): void {
    if (mode === currentMode && !pendingMode) return
    void window.refract.workingMode.set(sessionId, mode)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${current.label}, working mode${pendingLabel ? `. ${pendingLabel}` : ''}`}
          className={cn(PICKER_TRIGGER_CLASS)}
        >
          <CurrentIcon aria-hidden className="size-4" />
          <ValueCrossfade scope={sessionId} value={current.label} />
          {pendingLabel && <span className="text-muted-foreground">&middot; Switches when the turn ends</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={currentMode} onValueChange={(value) => handleSelect(value as WorkingMode)}>
          {MODE_ITEMS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value} icon={item.icon}>
              <div className="flex flex-col gap-1 py-1">
                <span>{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.hint}</span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
