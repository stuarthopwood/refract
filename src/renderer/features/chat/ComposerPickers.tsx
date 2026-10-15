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
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GaugeIcon, PaperclipIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatThinkingLevelLabel, THINKING_LEVEL_LABEL, THINKING_LEVELS } from '@/lib/modelDisplay'
import { attachImageFile } from './attachImage'
import { notify, useSessionsStore } from '@/state'
import type { ThinkingLevel } from '../../../shared/ipc-model'
import { PICKER_TRIGGER_CLASS, usePickerDisabled, usePickerOpenState } from './pickerShared'

export { ModelPicker } from './ModelPicker'

export function ReasoningPicker({ sessionId, boxDimmed }: { sessionId: string; boxDimmed: boolean }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const { disabled, notIdle, stopped } = usePickerDisabled(sessionId)
  const { open, onOpenChange } = usePickerOpenState(disabled)
  const thinkingLabel = formatThinkingLevelLabel(session ?? {})

  async function handleSelect(level: ThinkingLevel) {
    const result = await window.refract.model.setThinkingLevel(sessionId, level)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  const label = thinkingLabel ?? 'Reasoning not known yet'
  const disabledReason = notIdle ? 'Available once the session is idle.' : stopped ? 'Start the agent to change the reasoning level.' : null
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-disabled={disabled}
              aria-label={`Reasoning: ${label}${disabledReason ? `. ${disabledReason}` : ''}`}
              // Gate round 2 fix (LOW): the Tooltip's own content always duplicates something
              // already in the accessible name (the level when enabled, the disabled reason when
              // not) -- suppressed so a screen reader never says either twice; the Tooltip
              // itself still shows visually on hover and keyboard focus.
              aria-describedby={undefined}
              className={cn(PICKER_TRIGGER_CLASS, boxDimmed && 'aria-disabled:opacity-100')}
            >
              <GaugeIcon aria-hidden className="size-3" />
              <span>{label}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{disabledReason ?? label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {/* Gate round 1 fix (code-reviewer HIGH): a `DropdownMenuRadioGroup`/`RadioItem` bound to
            the Session's current level, instead of a plain `DropdownMenuItem` with a decorative
            `aria-hidden` check icon -- Radix exposes the current one as `aria-checked`/
            `role="menuitemradio"` automatically, so a screen reader hears it. */}
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

export function AttachButton({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    for (const file of Array.from(fileList)) {
      await attachImageFile(sessionId, file)
    }
  }

  return (
    <>
      {/* Gate round 1 fix (LOW): `hidden` rather than `sr-only` + `tabIndex={-1}` -- a screen
          reader's own browse mode no longer lands on a stray, do-nothing "Choose files" control
          that duplicates the visible Attach button below. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          void handleFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Attach images"
            aria-disabled={disabled}
            // Gate round 1 fix (LOW): the described-by Radix's own Tooltip auto-wires here would
            // just repeat this button's own accessible name ("Attach images" both places) -- a
            // screen reader would say it twice. Suppressed; the tooltip still shows visually.
            aria-describedby={undefined}
            // Composer-dimming fix (Stuart, 2026-10-15): no own opacity -- `disabled` here is
            // exactly MessageInput.tsx's own box-dim condition, so the box's single `opacity-60`
            // already covers this button; a second opacity-50 on top of it read too faint.
            className="aria-disabled:cursor-not-allowed"
            onClick={() => {
              if (disabled) return
              fileInputRef.current?.click()
            }}
          >
            <PaperclipIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Attach images</TooltipContent>
      </Tooltip>
    </>
  )
}
