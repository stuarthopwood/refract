import { BookmarkCheckIcon, HandIcon, PencilLineIcon, ZapIcon, type LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ValueCrossfade } from '@/components/ValueCrossfade'
import { useSessionsStore, useSettingsStore } from '@/state'
import { PICKER_TRIGGER_CLASS } from './pickerShared'
import type { ApprovalMode } from '../../../shared/model'

interface ModeItem {
  value: ApprovalMode
  label: string
  hint: string
  icon: LucideIcon
}

const MODE_ITEMS: ModeItem[] = [
  { value: 'ask', label: 'Ask', hint: 'Prompts for file changes and commands.', icon: HandIcon },
  { value: 'ask-and-remember', label: 'Ask and remember', hint: 'Prompts for file reads, changes and commands; remembers the files and folders you approve.', icon: BookmarkCheckIcon },
  { value: 'edit-freely', label: 'Edit freely', hint: 'Prompts for commands only.', icon: PencilLineIcon },
  { value: 'auto', label: 'Auto', hint: 'Never prompts.', icon: ZapIcon }
]

const MODE_LABEL: Record<ApprovalMode, string> = {
  ask: 'Ask',
  'ask-and-remember': 'Ask and remember',
  'edit-freely': 'Edit freely',
  auto: 'Auto'
}

export function ApprovalModePill({ sessionId }: { sessionId: string }) {
  const approvalMode = useSettingsStore((state) => state.settings.approvalMode)
  const setApprovalMode = useSettingsStore((state) => state.setApprovalMode)
  const session = useSessionsStore((state) => state.sessions.find((candidate) => candidate.id === sessionId))
  const isLive = session !== undefined && session.status !== 'stopped'
  const pendingMode = isLive ? session!.pendingMode : null
  const currentMode = isLive ? session!.launchedMode : approvalMode

  const current = MODE_ITEMS.find((item) => item.value === currentMode) ?? MODE_ITEMS[0]!
  const CurrentIcon = current.icon
  const pendingLabel = pendingMode ? `${MODE_LABEL[pendingMode]} after this turn` : null

  function handleSelect(mode: ApprovalMode): void {
    if (mode === approvalMode) return
    void setApprovalMode(mode)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${current.label}, approval mode${pendingLabel ? `. ${pendingLabel}` : ''}`}
          className={cn(
            PICKER_TRIGGER_CLASS,
          )}
        >
          <CurrentIcon aria-hidden className="size-4" />
          <ValueCrossfade scope={sessionId} value={current.label} />
          {pendingLabel && <span className="text-muted-foreground">&middot; {pendingLabel}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={currentMode} onValueChange={(value) => handleSelect(value as ApprovalMode)}>
          {MODE_ITEMS.map((item) => {
            return (
              <DropdownMenuRadioItem key={item.value} value={item.value} icon={item.icon}>
                <div className="flex flex-col gap-1 py-1">
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.hint}</span>
                </div>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
