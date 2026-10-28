// The composer's Reasoning picker and Attach button (#564 FR-064/FR-065). `ModelPicker` moved to
// its own file, `ModelPicker.tsx` (gate round 2, LOW: this file had grown to three components and
// 427 lines, past the single-responsibility threshold).
//
// Reasoning picker: a labelled trigger naming the Session's current value (the same last-known
// `lastThinkingLevel` value the old read-only line read, T062/T063). It stays enabled while the
// Session is working or stopped (#766 part B): a change is queued by Rust and shows the "next
// turn" clock glyph until applied. A
// `DropdownMenuRadioGroup`/`RadioItem` (gate round 1 fix, code-reviewer HIGH) exposes the current
// level as `aria-checked`/`role="menuitemradio"`, never a plain item with a decorative check
// icon. Gate round 2 (LOW): the disabled reason is now ALSO a visible Tooltip, not only the
// accessible name.
//
// Gate round 5 fixes (fifth-gate UI/UX review, PR #877, `agent://Arch877`):
// - A local `pendingLabel` mirrors `ModelPicker.tsx`'s own pending state: set for the duration of
//   `setThinkingLevel`, shown on the trigger with a `Loader2Icon`, `aria-busy`, and folded into
//   `usePickerOpenState`'s own `disabled` so the menu cannot reopen mid-request.
// - The accessible name now starts with the trigger's own visible text (the bare level, e.g.
//   "High") -- matching `ModelPicker.tsx`'s own fix for the SAME WCAG 2.5.3 finding -- with the
//   "Reasoning" noun moved to the Tooltip instead of prefixing the visible/accessible text.
// - `AttachButton` now names its OWN disabled reason (it previously stayed "Attach images" in
//   both the Tooltip and the accessible name while stopped, unlike both pickers), and uses the
//   same shared focus/disabled-opacity classes as everything else in this row.
//
// Gate round 6 fixes (`agent://Arch877`, action items):
// - The "Reasoning" noun suffix/prefix (accessible name and Tooltip) is now skipped whenever the
//   trigger's own label ALREADY starts with "Reasoning" ("Reasoning not reported"/"Reasoning not
//   known yet") -- it used to append unconditionally, reading "Reasoning not reported, reasoning"
//   and "Reasoning: Reasoning not reported".
// - `AttachButton` now imports the shared `COMPOSER_DISABLED_CLASS` (`pickerShared.tsx`) instead
//   of duplicating its exact string locally.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ClockIcon, Loader2Icon, PaperclipIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ReasoningGaugeIcon } from '@/components/ReasoningGaugeIcon'
import { formatThinkingLevelLabel, THINKING_LEVEL_LABEL, THINKING_LEVELS } from '@/lib/modelDisplay'
import { attachResolvedPaths, remainingAttachmentSlots } from './attachDroppedPaths'
import { notify, useSessionsStore } from '@/state'
import { useChatAreaAnnouncer } from './chatAreaAnnouncer'
import type { ThinkingLevel } from '../../../shared/ipc-model'
import { COMPOSER_DISABLED_CLASS, GHOST_BUTTON_FOCUS_CLASS, PICKER_TRIGGER_CLASS, usePickerOpenState } from './pickerShared'

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
              <span>{triggerLabel}</span>
              {nextLabel && pendingLabel === null && <ClockIcon aria-hidden data-pending-glyph className="size-4 shrink-0 text-foreground" />}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipContent}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {nextLabel && session?.lastThinkingLevel && (
          <>
            <DropdownMenuItem onSelect={() => void handleSelect(session.lastThinkingLevel as ThinkingLevel)}>Keep current ({label})</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {/* A `DropdownMenuRadioGroup` exposes the current level as `aria-checked`. */}
        <DropdownMenuRadioGroup value={session?.lastThinkingLevel ?? undefined} onValueChange={(value) => void handleSelect(value as ThinkingLevel)}>
          {THINKING_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
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

// #926: picks real absolute OS paths via the native multi-file dialog (`attachments.pickFiles`,
// no extension filter -- "any file type" is the point of this feature) and routes each one
// through `attachResolvedPaths` (`attachDroppedPaths.ts`), the SAME shared attach-loop/notify
// core #432's drag-and-drop already uses, generalised by #926 to also attach non-image files.
// Replaces the old `<input type="file">` element: Tauri's `File` API exposes no OS path for a
// picker-selected file (same gap `getPathForFile` already documents for a dropped `File`), so a
// non-image file picked that way would have no path to send as a path-only attachment.
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

  // Gate round 5 fix (Flow LOW): named its own disabled reason -- previously stayed "Attach
  // images" in both the Tooltip and the accessible name while stopped, unlike both pickers
  // (which already name theirs). #926: "images" -> "files" (Accessibility: "Drop-zone and Attach
  // wording change from 'images' to 'files'").
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
          // Gate round 1 fix (LOW): the described-by Radix's own Tooltip auto-wires here would
          // just repeat this button's own accessible name -- a screen reader would say it
          // twice. Suppressed; the tooltip still shows visually.
          aria-describedby={undefined}
          // Gate round 5 fix (Visual LOW): shares the SAME disabled-opacity value and the same
          // opaque focus outline every other composer control now uses, instead of its own
          // bespoke `opacity-60` and Button's default ring-based focus. Gate round 6 fix
          // (`agent://Arch877` Visual): imports `COMPOSER_DISABLED_CLASS` (`pickerShared.tsx`)
          // instead of duplicating its exact string, so the two can never drift apart. Gate
          // round 7 fix (`agent://Arch877` Visual L1): `button.tsx`'s `ghost` variant has its
          // own `dark:hover:bg-muted/50`, same specificity as the shared reset's
          // `aria-disabled:hover:bg-transparent` -- `dark:aria-disabled:hover:bg-transparent`
          // adds the extra `dark:` level so the reset wins in Dark/Dark-HC too.
          //
          // Live-check fix (verify-927-928-quiet-composer.mjs, real failure not a script bug):
          // Attach never picked up the SAME U1/U2 treatment `PICKER_TRIGGER_CLASS` already
          // gives its three siblings (Approval/Model/Reasoning) -- issue #927's own "Intended
          // behaviour" names all four as one set of ghost buttons, but Attach stayed on the
          // bare `Button variant="ghost"` with neither `cursor-pointer` (U2) nor the enforced
          // Dark-high-contrast resting border (U1, `border-composer-control-border`,
          // transparent in Dark/Obsidian so no visual change there). Not `PICKER_TRIGGER_CLASS`
          // itself -- that's sized as a padded text+icon pill (`h-6 px-2`); Attach stays the
          // icon-only square `size="icon-xs"` square its own design already is.
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
