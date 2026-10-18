// The composer's Reasoning picker and Attach button (#564 FR-064/FR-065). `ModelPicker` moved to
// its own file, `ModelPicker.tsx` (gate round 2, LOW: this file had grown to three components and
// 427 lines, past the single-responsibility threshold).
//
// Reasoning picker: a labelled trigger naming the Session's current value (the same last-known
// `lastThinkingLevel` value the old read-only line read, T062/T063). Disabled states match the
// Model picker (`pickerShared.tsx`'s `usePickerDisabled`/`usePickerOpenState`): refuses to open
// while working/needs-you, and also while stopped (showing the last-known value). A
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GaugeIcon, Loader2Icon, PaperclipIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatThinkingLevelLabel, THINKING_LEVEL_LABEL, THINKING_LEVELS } from '@/lib/modelDisplay'
import { attachResolvedPaths, remainingAttachmentSlots } from './attachDroppedPaths'
import { notify, useSessionsStore } from '@/state'
import type { ThinkingLevel } from '../../../shared/ipc-model'
import { COMPOSER_DISABLED_CLASS, GHOST_BUTTON_FOCUS_CLASS, PICKER_TRIGGER_CLASS, usePickerDisabled, usePickerOpenState } from './pickerShared'

export { ModelPicker } from './ModelPicker'

export function ReasoningPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const { disabled, notIdle, stopped } = usePickerDisabled(sessionId)
  // Gate round 5 fix (Flow Medium #9): set for the duration of `setThinkingLevel`; folded into
  // `usePickerOpenState`'s own disabled condition so the menu cannot reopen mid-request.
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  const effectiveDisabled = disabled || pendingLabel !== null
  const { open, onOpenChange } = usePickerOpenState(effectiveDisabled)
  const thinkingLabel = formatThinkingLevelLabel(session ?? {})

  async function handleSelect(level: ThinkingLevel) {
    setPendingLabel(THINKING_LEVEL_LABEL[level] ?? level)
    try {
      const result = await window.refract.model.setThinkingLevel(sessionId, level)
      if (!result.ok) notify({ code: result.error.code, message: result.error.message })
    } finally {
      setPendingLabel(null)
    }
  }

  const label = thinkingLabel ?? 'Reasoning not known yet'
  const disabledReason = notIdle ? 'Available once the session is idle.' : stopped ? 'Start the agent to change the reasoning level.' : null
  const triggerLabel = pendingLabel ?? label
  // Gate round 5 fix (Flow Medium #11): the accessible name now STARTS with the trigger's own
  // visible text (WCAG 2.5.3, `docs/design/accessibility.md:16`) -- the "Reasoning" noun moves to
  // the Tooltip below instead of prefixing the name, the same choice `ModelPicker.tsx` makes for
  // its own "Model: ..." prefix (consistency decision, gate round 5 Medium #11). Gate round 6 fix
  // (`agent://Arch877` Medium 3): both the unset-level labels ("Reasoning not reported"/
  // "Reasoning not known yet") already START with "Reasoning" -- appending the noun
  // unconditionally doubled it ("Reasoning not reported, reasoning"); the noun is now added only
  // when the trigger's own label does not already start with it.
  const startsWithReasoning = /^reasoning\b/i.test(triggerLabel)
  const ariaLabel = `${triggerLabel}${startsWithReasoning ? '' : ', reasoning'}${disabledReason ? `. ${disabledReason}` : pendingLabel ? '. Applying…' : ''}`
  const tooltipContent = disabledReason ?? (pendingLabel ? 'Applying…' : /^reasoning\b/i.test(label) ? label : `Reasoning: ${label}`)
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-disabled={effectiveDisabled}
              aria-busy={pendingLabel !== null}
              aria-label={ariaLabel}
              // Gate round 2 fix (LOW): the Tooltip's own content always duplicates something
              // already in the accessible name (the level when enabled, the disabled reason when
              // not) -- suppressed so a screen reader never says either twice; the Tooltip
              // itself still shows visually on hover and keyboard focus.
              aria-describedby={undefined}
              className={PICKER_TRIGGER_CLASS}
            >
              {pendingLabel !== null ? (
                <Loader2Icon aria-hidden className="size-3 animate-spin" />
              ) : (
                <GaugeIcon aria-hidden className="size-3" />
              )}
              <span>{triggerLabel}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipContent}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {/* Gate round 1 fix (code-reviewer HIGH): a `DropdownMenuRadioGroup`/`RadioItem` bound to
            the Session's current level, instead of a plain `DropdownMenuItem` with a decorative
            `aria-hidden` check icon -- Radix exposes the current one as `aria-checked`/
            `role="menuitemradio"` automatically. */}
        <DropdownMenuRadioGroup value={session?.lastThinkingLevel ?? undefined} onValueChange={(value) => void handleSelect(value as ThinkingLevel)}>
          {THINKING_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
              {THINKING_LEVEL_LABEL[level]}
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
    await attachResolvedPaths(sessionId, resolved, [], paths.length, remainingSlots, false)
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
          // itself -- that's sized as a padded text+icon pill (`h-6 px-2.5`); Attach stays the
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
