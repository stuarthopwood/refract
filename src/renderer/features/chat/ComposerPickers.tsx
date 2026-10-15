// #564: the composer's model and reasoning pickers, inside the message box's own bottom row,
// replacing the old read-only CpuIcon/GaugeIcon line (FR-041, superseded by FR-064). Each is a
// labelled menu button naming the Session's current value (the same `lastModel`/
// `lastThinkingLevel` last-known values the old line read, T062/T063), so a Session whose agent
// is not running still shows its last value exactly as before.
//
// Rust (Tauri) build only: Stuart approved R13 (delete Electron) 2026-10-15, running concurrently
// in a separate worktree, so these pickers target `window.refract.model` (lane RM, #454/#740/
// #741/#762/#766/#760, #564) directly with no Electron-specific read-only fallback branch --
// Electron's main process was frozen (rule 10) and is now being deleted outright, so a dead
// fallback path for it would be wasted effort. `window.refract.model` stays typed optional in
// `shared/ipc.ts` (unchanged here, out of scope); the non-null assertions below reflect that this
// is the Rust build's own contract, not a runtime guess.
//
// Both pickers refuse to open while the Session is not idle (working or needs-you) -- the same
// two statuses `request_rpc_if_idle` (src-tauri/src/session/agent/lane_support.rs) refuses
// `set_model`/`set_thinking_level` for -- shown as an `aria-disabled` state with the reason folded
// into the accessible name, rather than a silent failure once the underlying call itself would
// refuse.
import { useRef, useState } from 'react'
import { CheckIcon, CpuIcon, GaugeIcon, PaperclipIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatModelLabel, formatThinkingLevelLabel, THINKING_LEVEL_LABEL, THINKING_LEVELS } from '@/lib/modelDisplay'
import { notify, useDraftStore, useModelRolesStore, useSessionsStore } from '@/state'
import { buildImageAttachment, formatByteSize } from './attachments'
import { MAX_IMAGE_INPUT_BYTES } from '../../../shared/images'
import type { ModelCatalogEntry } from '../../../shared/model'
import type { ThinkingLevel } from '../../../shared/ipc-model'

function useNotIdle(sessionId: string) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status ?? 'stopped')
  return status === 'working' || status === 'needs-you'
}

const PICKER_TRIGGER_CLASS = cn(
  badgeVariants({ variant: 'outline' }),
  'h-6 shrink-0 gap-1.5 px-2.5 hover:bg-muted aria-expanded:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50'
)

export function ModelPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const notIdle = useNotIdle(sessionId)
  const modelLabel = formatModelLabel(session ?? {})
  const catalog = useModelRolesStore((s) => s.catalogs.chat)
  const catalogError = useModelRolesStore((s) => s.catalogErrors.chat)
  const loadCatalog = useModelRolesStore((s) => s.loadCatalog)
  const [open, setOpen] = useState(false)

  async function handleSelect(entry: ModelCatalogEntry) {
    const result = await window.refract.model!.setModel(sessionId, entry.provider, entry.id)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  const disabledSuffix = notIdle ? '. Available once the session is idle.' : ''
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (notIdle) return
        setOpen(next)
        if (next) void loadCatalog('chat')
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-disabled={notIdle}
          aria-label={`Model: ${modelLabel ?? 'not known yet'}${disabledSuffix}`}
          className={PICKER_TRIGGER_CLASS}
        >
          <CpuIcon aria-hidden className="size-3" />
          <span className="max-w-40 truncate font-code">{modelLabel ?? 'Model not known yet'}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {catalogError && <DropdownMenuItem disabled>{catalogError}</DropdownMenuItem>}
        {!catalogError && (catalog ?? []).length === 0 && <DropdownMenuItem disabled>Loading models…</DropdownMenuItem>}
        {!catalogError &&
          (catalog ?? []).map((entry) => {
            const checked = modelLabel === `${entry.provider}/${entry.name}`
            return (
              <DropdownMenuItem key={entry.selector} onSelect={() => void handleSelect(entry)}>
                <span className="min-w-0 flex-1 truncate font-code text-xs">{entry.name}</span>
                {checked && <CheckIcon aria-hidden className="size-3.5" />}
              </DropdownMenuItem>
            )
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ReasoningPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const notIdle = useNotIdle(sessionId)
  const thinkingLabel = formatThinkingLevelLabel(session ?? {})
  const [open, setOpen] = useState(false)

  async function handleSelect(level: ThinkingLevel) {
    const result = await window.refract.model!.setThinkingLevel(sessionId, level)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  const disabledSuffix = notIdle ? '. Available once the session is idle.' : ''
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (notIdle) return
        setOpen(next)
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-disabled={notIdle}
          aria-label={`Reasoning: ${thinkingLabel ?? 'not known yet'}${disabledSuffix}`}
          className={PICKER_TRIGGER_CLASS}
        >
          <GaugeIcon aria-hidden className="size-3" />
          <span>{thinkingLabel ?? 'Reasoning not known yet'}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {THINKING_LEVELS.map((level) => (
          <DropdownMenuItem key={level} onSelect={() => void handleSelect(level)}>
            <span className="flex-1">{THINKING_LEVEL_LABEL[level]}</span>
            {session?.lastThinkingLevel === level && <CheckIcon aria-hidden className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AttachButton({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  // #564: shares `buildImageAttachment`'s exact validation and toast wording with
  // `MessageInput.tsx`'s own paste handler (same renderer-only pipeline, spec 009) rather than a
  // second copy -- the only difference from a paste is where the `File` comes from. Renderer-only
  // (a hidden native file input, no new IPC): no main-process change either shell would need.
  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    for (const file of Array.from(fileList)) {
      const result = await buildImageAttachment(file)
      if (!result.ok) {
        notify({
          code: result.reason === 'too-large' ? 'image-too-large' : 'invalid-argument',
          message:
            result.reason === 'too-large'
              ? `Image is too large to attach (over the ${formatByteSize(MAX_IMAGE_INPUT_BYTES)} limit); nothing was attached.`
              : 'That image could not be read; nothing was attached.'
        })
        continue
      }
      useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
      useDraftStore.getState().announceAttachment(sessionId, `Image attached, ${formatByteSize(result.attachment.byteLength)}.`)
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="sr-only"
        tabIndex={-1}
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
