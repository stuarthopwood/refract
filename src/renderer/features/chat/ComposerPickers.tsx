// The composer's Reasoning picker and Attach button. A level change is queued by Rust and shows the "next turn" clock glyph until applied. (#564, #766)
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CheckIcon, ClockIcon, Link2Icon, Loader2Icon, PaperclipIcon, SignalHighIcon, SignalIcon, SignalLowIcon, SignalMediumIcon, SignalZeroIcon, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ReasoningGaugeIcon } from '@/components/ReasoningGaugeIcon'
import { ValueCrossfade } from '@/components/ValueCrossfade'
import { formatThinkingLevelLabel, THINKING_LEVEL_LABEL, THINKING_LEVELS } from '@/lib/modelDisplay'
import { attachResolvedPaths, remainingAttachmentSlots } from './attachDroppedPaths'
import { notify, useSessionsStore } from '@/state'
import { useChatAreaAnnouncer } from './chatAreaAnnouncer'
import type { ThinkingLevel } from '../../../shared/ipc-model'
import { COMPOSER_DISABLED_CLASS, GHOST_BUTTON_FOCUS_CLASS, PICKER_TRIGGER_CLASS, usePickerOpenState } from './pickerShared'

const LEVEL_ICON: Record<ThinkingLevel, LucideIcon> = {
  inherit: Link2Icon,
  off: SignalZeroIcon,
  minimal: SignalLowIcon,
  low: SignalLowIcon,
  medium: SignalMediumIcon,
  high: SignalHighIcon,
  xhigh: SignalIcon,
  max: SignalIcon
}

export function ReasoningPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const announce = useChatAreaAnnouncer((s) => s.announce)
  // Set for the duration of `setThinkingLevel`; folded into `usePickerOpenState` so the menu
  // cannot reopen mid-request.
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  const { open, onOpenChange } = usePickerOpenState(pendingLabel !== null)
  const thinkingLabel = formatThinkingLevelLabel(session ?? {})
  const nextLevel = session?.pendingSelection?.thinkingLevel ?? null
  const nextLabel = nextLevel ? (THINKING_LEVEL_LABEL[nextLevel as ThinkingLevel] ?? nextLevel) : null
  const stopped = session?.status === 'stopped'

  async function handleSelect(level: ThinkingLevel) {
    setPendingLabel(THINKING_LEVEL_LABEL[level] ?? level)
    try {
      const result = await window.refract.model.setThinkingLevel(sessionId, level)
      if (!result.ok) return notify(result.error, sessionId)
      if (result.value.queued) announce(`${THINKING_LEVEL_LABEL[level] ?? level} queued for next turn`)
    } finally {
      setPendingLabel(null)
    }
  }

  const label = thinkingLabel ?? 'Reasoning not known yet'
  const triggerLabel = pendingLabel ?? nextLabel ?? label
  // The accessible name starts with the trigger's visible text (WCAG 2.5.3); the "Reasoning"
  // noun is added only when the label does not already start with it.
  const startsWithReasoning = /^reasoning\b/i.test(triggerLabel)
  const pendingSuffix = nextLabel ? (stopped ? ', applies when the agent starts' : ', applies next turn') : ''
  const ariaLabel = `${triggerLabel}${startsWithReasoning ? '' : ', reasoning'}${pendingSuffix}${pendingLabel ? '. Applying…' : ''}`
  const tooltipContent = pendingLabel
    ? 'Applying…'
    : nextLabel
      ? `${stopped ? 'Applies when the agent starts' : 'Applies on next turn'}. Now: ${label}.`
      : /^reasoning\b/i.test(label)
        ? label
        : `Reasoning: ${label}`
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-busy={pendingLabel !== null}
              aria-label={ariaLabel}
              // The Tooltip repeats the accessible name; suppress the described-by so a screen
              // reader never says it twice.
              aria-describedby={undefined}
              className={PICKER_TRIGGER_CLASS}
            >
              {pendingLabel !== null ? (
                <Loader2Icon aria-hidden className="size-4 animate-spin" />
              ) : (
                <ReasoningGaugeIcon level={nextLevel ?? session?.lastThinkingLevel} className="size-4" />
              )}
              <ValueCrossfade scope={sessionId} value={triggerLabel} />
              {nextLabel && pendingLabel === null && <ClockIcon aria-hidden data-pending-glyph className="size-4 shrink-0 text-foreground" />}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipContent}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="max-w-64">
        {nextLabel && session?.lastThinkingLevel && (
          <>
            <DropdownMenuItem icon={CheckIcon} onSelect={() => void handleSelect(session.lastThinkingLevel as ThinkingLevel)}>Keep current ({label})</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {/* A `DropdownMenuRadioGroup` exposes the current level as `aria-checked`. */}
        <DropdownMenuRadioGroup value={session?.lastThinkingLevel ?? undefined} onValueChange={(value) => void handleSelect(value as ThinkingLevel)}>
          {THINKING_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={level} icon={LEVEL_ICON[level]}>
              <span className="min-w-0 flex-1 truncate">
                {THINKING_LEVEL_LABEL[level]}
                {level === nextLevel && <span className="text-xs text-muted-foreground"> next</span>}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Picks OS paths via the native dialog (Tauri's `File` exposes no path) and attaches them through the shared drag-and-drop core. (#926)
export function AttachButton({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  async function handlePickFiles() {
    if (disabled) return
    const result = await window.refract.attachments.pickFiles(sessionId)
    if (!result.ok) {
      notify(result.error)
      return
    }
    const paths = result.value
    if (paths.length === 0) return // dialog cancelled
    const remainingSlots = remainingAttachmentSlots(sessionId)
    const capped = paths.slice(0, remainingSlots)
    const resolved = capped.map((filePath) => ({ name: filePath.split(/[\\/]/).pop() ?? filePath, filePath }))
    await attachResolvedPaths(sessionId, resolved, [], paths.length, remainingSlots, false, 'picker')
  }

  const disabledReason = disabled ? 'Start the agent to attach files.' : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Attach files${disabledReason ? `. ${disabledReason}` : ''}`}
          aria-disabled={disabled}
          // The Tooltip would repeat the accessible name via described-by; suppress it.
          aria-describedby={undefined}
          // Dark variant needed so the disabled hover reset beats `ghost`'s `dark:hover:bg-muted/50`; border/cursor match the sibling pickers.
          className={cn(
            'cursor-pointer border-composer-control-border',
            COMPOSER_DISABLED_CLASS,
            'dark:aria-disabled:hover:bg-transparent',
            GHOST_BUTTON_FOCUS_CLASS
          )}
          onClick={() => void handlePickFiles()}
        >
          <PaperclipIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{disabledReason ?? 'Attach files'}</TooltipContent>
    </Tooltip>
  )
}
