// #564: the composer's model and reasoning pickers, inside the message box's own bottom row,
// replacing the old read-only CpuIcon/GaugeIcon line (FR-041, superseded by FR-064). Each is a
// labelled menu button naming the Session's current value (the same `lastModel`/
// `lastThinkingLevel` last-known values the old line read, T062/T063), so a Session whose agent
// is not running still shows its last value exactly as before.
//
// Rust (Tauri) build only: Stuart approved R13 (delete Electron) 2026-10-15, running concurrently
// in a separate worktree, so these pickers target `window.refract.model` directly with no
// Electron-specific fallback branch.
//
// Disabled states (2026-10-15 grill, issue #564, decision 3): while the Session is working or
// needs-you ("not idle"), the picker refuses to open with "Available once the session is idle."
// in its accessible name, matching the underlying `request_rpc_if_idle` refusal
// (src-tauri/src/session/agent/lane_support.rs). While the Session is stopped (no running
// agent), the picker shows its last-known value but is ALSO disabled, with "Start the agent to
// change the model/reasoning level." in its name -- nothing is stored for the next start, since
// a disabled picker never calls the underlying IPC at all.
//
// Model picker (decision 6): the menu opens with a type-to-filter text field at the top (focus
// starts there, via `onOpenAutoFocus`), a Roles group first (the Session's own role listing,
// `model.listRoles`, applied through the existing `model.applyRole` action -- the same action
// the Ctrl+R selector and `/role` already use), then the filtered catalog model list with the
// current one ticked, scrolling once the list passes about 12 rows.
import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckIcon, CpuIcon, GaugeIcon, PaperclipIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatModelLabel, formatThinkingLevelLabel, THINKING_LEVEL_LABEL, THINKING_LEVELS } from '@/lib/modelDisplay'
import { notify, useDraftStore, useModelRolesStore, useSessionsStore } from '@/state'
import { buildImageAttachment, formatByteSize } from './attachments'
import { MAX_IMAGE_INPUT_BYTES } from '../../../shared/images'
import type { ModelCatalogEntry } from '../../../shared/model'
import type { ThinkingLevel } from '../../../shared/ipc-model'

/** `notIdle`: the Session is working or needs-you -- the API's own mid-turn refusal rule.
 * `stopped`: no agent is running at all; a picker still shows the last-known value but cannot
 * change it either (decision 3). Either state disables the trigger, with its own reason text. */
function usePickerDisabled(sessionId: string) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status ?? 'stopped')
  const notIdle = status === 'working' || status === 'needs-you'
  const stopped = status === 'stopped'
  return { disabled: notIdle || stopped, notIdle, stopped }
}

const PICKER_TRIGGER_CLASS = cn(
  badgeVariants({ variant: 'outline' }),
  'h-6 shrink-0 gap-1.5 px-2.5 hover:bg-muted aria-expanded:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50'
)

/** Scrolls the model list once it passes about 12 rows (decision 6) rather than growing the menu
 * to fit every one of the catalog's 91 chat models unbounded. */
const MODEL_LIST_MAX_HEIGHT_CLASS = 'max-h-96 overflow-y-auto'

export function ModelPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const { disabled, notIdle, stopped } = usePickerDisabled(sessionId)
  const modelLabel = formatModelLabel(session ?? {})
  const catalog = useModelRolesStore((s) => s.catalogs.chat)
  const catalogError = useModelRolesStore((s) => s.catalogErrors.chat)
  const loadCatalog = useModelRolesStore((s) => s.loadCatalog)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [roles, setRoles] = useState<Array<{ role: string; model: string | null; current: boolean }> | null>(null)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const filterInputRef = useRef<HTMLInputElement>(null)

  // Radix's `DropdownMenu.Content` has no public `onOpenAutoFocus` hook (unlike Dialog/
  // AlertDialog) -- it manages initial focus internally, and keeps re-asserting it for a few
  // ticks after mount (a single later call, even via `requestAnimationFrame`, still loses the
  // race). Retried at three short delays to reliably land last, rather than a fragile one-shot
  // timing guess (decision 6: "focus starts there").
  useEffect(() => {
    if (!open) return
    const timers = [0, 50, 150].map((delay) => setTimeout(() => filterInputRef.current?.focus(), delay))
    return () => timers.forEach(clearTimeout)
  }, [open])

  const filteredCatalog = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const entries = catalog ?? []
    if (!needle) return entries
    return entries.filter((entry) => `${entry.provider} ${entry.name}`.toLowerCase().includes(needle))
  }, [catalog, filter])

  async function handleSelectModel(entry: ModelCatalogEntry) {
    const result = await window.refract.model!.setModel(sessionId, entry.provider, entry.id)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  async function handleSelectRole(role: string) {
    const result = await window.refract.model!.applyRole(sessionId, role)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  /** The role list's own `model` field is a raw `provider/id` selector (never a friendly name,
   * #741); look it up against the already-loaded catalog for display, falling back to the raw
   * selector when the catalog hasn't loaded yet or doesn't list it. */
  function friendlyRoleModel(selector: string | null): string {
    if (!selector) return 'unset'
    const match = (catalog ?? []).find((entry) => `${entry.provider}/${entry.id}` === selector)
    return match ? match.name : selector
  }

  const disabledSuffix = notIdle ? '. Available once the session is idle.' : stopped ? '. Start the agent to change the model.' : ''
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (disabled) return
        setOpen(next)
        if (next) {
          void loadCatalog('chat')
          setFilter('')
          void window.refract.model!.listRoles(sessionId).then((result) => {
            if (result.ok) {
              setRoles(result.value.roles)
              setRolesError(null)
            } else {
              setRoles([])
              setRolesError(result.error.message)
            }
          })
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-disabled={disabled}
          aria-label={`Model: ${modelLabel ?? 'not known yet'}${disabledSuffix}`}
          className={PICKER_TRIGGER_CLASS}
        >
          <CpuIcon aria-hidden className="size-3" />
          <span className="max-w-40 truncate font-code">{modelLabel ?? 'Model not known yet'}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <div className="p-1">
          <Input
            ref={filterInputRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter models…"
            aria-label="Filter models"
            className="h-7"
          />
        </div>
        {roles !== null && roles.length > 0 && (
          <>
            <DropdownMenuLabel>Roles</DropdownMenuLabel>
            {roles.map((role) => (
              <DropdownMenuItem key={role.role} onSelect={() => void handleSelectRole(role.role)}>
                <span className="min-w-0 flex-1 truncate">
                  {role.role}{' '}
                  <span className="font-code text-xs text-muted-foreground">{friendlyRoleModel(role.model)}</span>
                </span>
                {role.current && <CheckIcon aria-hidden className="size-3.5" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {rolesError && <DropdownMenuItem disabled>{rolesError}</DropdownMenuItem>}
        <DropdownMenuLabel>Models</DropdownMenuLabel>
        <div className={MODEL_LIST_MAX_HEIGHT_CLASS}>
          {catalogError && <DropdownMenuItem disabled>{catalogError}</DropdownMenuItem>}
          {!catalogError && filteredCatalog.length === 0 && (
            <DropdownMenuItem disabled>{(catalog ?? []).length === 0 ? 'Loading models…' : 'No models match.'}</DropdownMenuItem>
          )}
          {!catalogError &&
            filteredCatalog.map((entry) => {
              const checked = modelLabel === `${entry.provider}/${entry.name}`
              return (
                <DropdownMenuItem key={entry.selector} onSelect={() => void handleSelectModel(entry)}>
                  <span className="min-w-0 flex-1 truncate font-code text-xs">{entry.name}</span>
                  {checked && <CheckIcon aria-hidden className="size-3.5" />}
                </DropdownMenuItem>
              )
            })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ReasoningPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const { disabled, notIdle, stopped } = usePickerDisabled(sessionId)
  const thinkingLabel = formatThinkingLevelLabel(session ?? {})
  const [open, setOpen] = useState(false)

  async function handleSelect(level: ThinkingLevel) {
    const result = await window.refract.model!.setThinkingLevel(sessionId, level)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  const disabledSuffix = notIdle ? '. Available once the session is idle.' : stopped ? '. Start the agent to change the reasoning level.' : ''
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (disabled) return
        setOpen(next)
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-disabled={disabled}
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
