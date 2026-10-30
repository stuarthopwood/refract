// Approval mode pill (docs/DESIGN.md "Chat"; FR-015, FR-020, FR-054, FR-056; spec 001 FR-065):
// the single home for the app-wide Approval mode, first in the composer box's own bottom row
// (`MessageInput.tsx`; moved there from the status line above by #496, gate round 5 fix: this
// comment still said "the chip row directly above the message box", stale since #564 moved it
// INTO the box). Replaces the old status-bar ToggleGroup (StatusBar.tsx, T098)
// and the chat header's pending-mode Badge (ChatHeader.tsx, T098) -- both read/wrote the exact
// same `settings.approvalMode` / session `pendingMode`, so this is the one place left that does.
// The pill's "current" mode is the Session's own `launchedMode` while its agent is actually LIVE
// (status !== 'stopped'): while `pendingMode` is set, the session is still running under the mode
// it actually launched with, not the new one, until it restarts at its next idle settle -- showing
// the new mode as already current here would misrepresent what approval behaviour actually governs
// the live turn. Once the agent is `stopped` (exited, failed to start, or a failed mode restart --
// `SessionManager` keeps the `SessionAgent` around after a stop, only removing it on delete), there
// is no live turn for `launchedMode` to describe, so the pill falls back to the global Settings
// mode instead; a stale `launchedMode` from the session's last run would otherwise freeze the pill
// on a mode the app-wide setting has since moved on from (regression fixed here).
import type { ComponentType } from 'react'
import { BookmarkCheckIcon, HandIcon, PencilLineIcon, ZapIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useSessionsStore, useSettingsStore } from '@/state'
import { PICKER_TRIGGER_CLASS } from './pickerShared'
import type { ApprovalMode } from '../../../shared/model'

interface ModeItem {
  value: ApprovalMode
  label: string
  hint: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
}

// FR-015's levels plus #496's Ask and remember (second, after Ask), each with the lucide icon
// FR-056 asks for and a one-line description of what it prompts for.
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
  // `pendingMode`/`launchedMode` only describe a live agent's in-flight mode change; a stopped
  // Session (never launched, exited, start failed, or a failed mode restart) has no live turn for
  // either to describe, so both fall back to the global Settings mode (no pending change, current
  // = whatever the app-wide setting now is) rather than freezing on a stale value from its last run.
  const pendingMode = isLive ? session!.pendingMode : null
  // The mode actually in effect right now: the Session's own launched mode while its agent is live,
  // or the global Settings mode while it is stopped (see comment above).
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
          // Gate round 5 fix (Flow Medium #11): starts with the trigger's own visible text
          // ("Ask"/"Edit freely"/"Auto"), matching the SAME fix on the Model and Reasoning
          // pickers (WCAG 2.5.3, `docs/design/accessibility.md:16`).
          aria-label={`${current.label}, approval mode${pendingLabel ? `. ${pendingLabel}` : ''}`}
          className={cn(
            PICKER_TRIGGER_CLASS,
            // Gate round 6 fix (`agent://Arch877` Visual N7): was a one-off duplicate of
            // `pickerShared.tsx`'s own trigger class (including its stale 6px gap, missed when
            // that shared class moved to `gap-2`) -- now reads the shared class directly, so the
            // two can never drift apart again. `COMPOSER_DISABLED_CLASS` folded in here never
            // activates: this pill is never `aria-disabled`.
          )}
        >
          <CurrentIcon aria-hidden className="size-4" />
          {current.label}
          {pendingLabel && <span className="text-muted-foreground">&middot; {pendingLabel}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {/* #1065: the same leading ring-and-dot current-choice mark as the Reasoning and Theme menus. */}
        <DropdownMenuRadioGroup value={currentMode} onValueChange={(value) => handleSelect(value as ApprovalMode)}>
          {MODE_ITEMS.map((item) => {
            const ItemIcon = item.icon
            return (
              <DropdownMenuRadioItem key={item.value} value={item.value}>
                <ItemIcon aria-hidden className="size-4" />
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
