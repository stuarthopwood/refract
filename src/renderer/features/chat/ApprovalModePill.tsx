// Approval mode pill (docs/DESIGN.md "Chat"; FR-015, FR-020, FR-054, FR-056): the single home for
// the app-wide Approval mode, sitting as the first item in the chip row directly above the
// message box (MessageInput.tsx). Replaces the old status-bar ToggleGroup (StatusBar.tsx, T098)
// and the chat header's pending-mode Badge (ChatHeader.tsx, T098) -- both read/wrote the exact
// same `settings.approvalMode` / session `pendingMode`, so this is the one place left that does.
// The pill's "current" mode is the Session's own `launchedMode` (falling back to the global
// Settings mode for a Session that has never launched), never the global Settings mode directly:
// while `pendingMode` is set, the session is still running under the mode it actually launched
// with, not the new one, until it restarts at its next idle settle -- showing the new mode as
// already current here would misrepresent what approval behaviour actually governs the live turn.
import type { ComponentType } from 'react'
import { CheckIcon, HandIcon, PencilLineIcon, ZapIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useSessionsStore, useSettingsStore } from '@/state'
import type { ApprovalMode } from '../../../shared/model'

interface ModeItem {
  value: ApprovalMode
  label: string
  hint: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
}

// FR-015's three levels, each with the lucide icon FR-056 asks for and a one-line description of
// what it prompts for (reads are never prompted in any mode).
const MODE_ITEMS: ModeItem[] = [
  { value: 'ask', label: 'Ask', hint: 'Prompts for file changes and commands.', icon: HandIcon },
  { value: 'edit-freely', label: 'Edit freely', hint: 'Prompts for commands only.', icon: PencilLineIcon },
  { value: 'auto', label: 'Auto', hint: 'Never prompts.', icon: ZapIcon }
]

const MODE_LABEL: Record<ApprovalMode, string> = {
  ask: 'Ask',
  'edit-freely': 'Edit freely',
  auto: 'Auto'
}

export function ApprovalModePill({ sessionId }: { sessionId: string }) {
  const approvalMode = useSettingsStore((state) => state.settings.approvalMode)
  const setApprovalMode = useSettingsStore((state) => state.setApprovalMode)
  const session = useSessionsStore((state) => state.sessions.find((candidate) => candidate.id === sessionId))
  const pendingMode = session?.pendingMode
  // The mode actually in effect right now: the Session's own launched mode while it is live, or
  // the global Settings mode for one that has never launched (same value the Settings store
  // itself would seed `launchedMode` with on its first launch, see `SessionManager.summaries`).
  const currentMode = session?.launchedMode ?? approvalMode

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
          aria-label={`Approval mode: ${current.label}${pendingLabel ? `. ${pendingLabel}` : ''}`}
          className={cn(
            badgeVariants({ variant: 'outline' }),
            'h-6 shrink-0 gap-1.5 px-2.5 hover:bg-muted aria-expanded:bg-muted'
          )}
        >
          <CurrentIcon aria-hidden className="size-3" />
          {current.label}
          {pendingLabel && <span className="text-muted-foreground">&middot; {pendingLabel}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {MODE_ITEMS.map((item) => {
          const ItemIcon = item.icon
          const checked = item.value === currentMode
          return (
            <DropdownMenuItem key={item.value} onSelect={() => handleSelect(item.value)}>
              <ItemIcon aria-hidden className="size-4" />
              <div className="flex flex-col gap-0.5 py-0.5">
                <span className="flex items-center gap-1.5 font-medium">
                  {item.label}
                  {checked && (
                    <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                      <CheckIcon aria-hidden className="size-3.5" />
                      Current
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{item.hint}</span>
              </div>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
