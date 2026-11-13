// The composer shell shared by the main message box (`MessageInput.tsx`) and the side chat
// (`SideChatPanel.tsx`), #675: the box (border, radius, focus ring), the field block with its
// Send/Stop action slot, the optional bottom row, the text field and the Send and Stop buttons.
// A new consumer extends this by prop or slot; it never copies the markup.
import type { ComponentProps, KeyboardEventHandler, ReactNode } from 'react'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ComposerContextMenu } from '@/components/ComposerContextMenu'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/components/ui/composerFocus'
import { COMPOSER_DISABLED_OPACITY_CLASS } from '@/features/chat/pickerShared'
import { cn } from '@/lib/utils'

/** The composer's type: the UI font at `--text-readout` (#839). `md:text-readout` replaces the
 * `Textarea` primitive's own `md:text-sm`. The textarea and every mirror layer (ghost text,
 * command pill, chip overlays, hint overlay) use this one constant, so none can drift off the
 * typed text. */
export const COMPOSER_TEXT_CLASS = 'font-ui text-readout md:text-readout leading-normal tracking-normal'

/** Box-model-matching classes for every inert composer mirror (see `CommandPillOverlay.tsx` for why each one). */
export const COMPOSER_MIRROR_CLASS = `pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-2 pr-20 text-foreground [scrollbar-gutter:stable] ${COMPOSER_TEXT_CLASS}`

/** The composer's selection highlight: a translucent accent tint with a dedicated text colour,
 * and the OS `Highlight` pair in forced colours (`CommandPillOverlay.tsx` has the history). */
export const COMPOSER_SELECTION_CLASS =
  'selection:bg-composer-selection-bg selection:text-composer-selection-fg selection:[-webkit-text-fill-color:currentColor] forced-colors:selection:bg-[Highlight] forced-colors:selection:text-[HighlightText] forced-colors:selection:[-webkit-text-fill-color:HighlightText]'

const COMPOSER_TEXTAREA_CLASS =
  'max-h-48 min-h-16 resize-none overflow-y-auto border-none bg-transparent shadow-none transition-[border-color,box-shadow] placeholder:text-composer-placeholder focus-visible:border-none focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 disabled:placeholder:text-foreground dark:bg-transparent dark:disabled:bg-transparent forced-colors:placeholder:text-[GrayText] [scrollbar-gutter:stable]'

/** The composer's text field. `transition-[border-color,box-shadow]` narrows the primitive's
 * `transition-colors` so a fill swap (a command pill mounting) never fades against its mirror.
 * `actionCount` sizes the right padding to the round buttons in `ComposerActions` (an
 * `icon-sm` button plus its gap is 2.5rem), so text never runs under them. */
export function ComposerTextarea({ className, actionCount = 2, ...props }: ComponentProps<'textarea'> & { actionCount?: 0 | 1 | 2 }) {
  const reservedPadding = actionCount === 0 ? undefined : actionCount === 1 ? 'pr-10' : 'pr-20'
  return (
    <ComposerContextMenu>
      <Textarea className={cn(COMPOSER_SELECTION_CLASS, COMPOSER_TEXT_CLASS, COMPOSER_TEXTAREA_CLASS, reservedPadding, className)} {...props} />
    </ComposerContextMenu>
  )
}

/** The box: border, radius and fill from the per-theme composer tokens. The ring shows only on the
 * textarea's own `:focus-visible`; each control inside draws its own focus outline. Holds a
 * `ComposerField` and optionally a `ComposerFooter`. */
export function ComposerBox({ children, className, onKeyDown }: { children: ReactNode; className?: string; onKeyDown?: KeyboardEventHandler<HTMLDivElement> }) {
  return (
    <div
      onKeyDown={onKeyDown}
      className={cn(
        'flex flex-col gap-1 rounded-lg border border-composer-border bg-composer-background pt-1 has-[textarea:focus-visible]:border-composer-focus has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-composer-ring',
        className
      )}
    >
      {children}
    </div>
  )
}

/** The field block: the textarea, its inert mirrors and menus, and `ComposerActions`. `disabled`
 * dims the block as one layer; the box edge never dims. `data-text-role="code"` keeps the field
 * on the Code text scale (Settings > Appearance) although it no longer uses the Code font. */
export function ComposerField({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <div data-text-role="code" className={cn('relative flex items-end', disabled && 'opacity-60')}>
      {children}
    </div>
  )
}

/** Send/Stop slot, centred on the field's right edge via `top-1/2` so it stays centred as the
 * textarea grows. `z-[3]` sits above the textarea (`z-[1]` while a command pill shows) and the
 * mirrors (`z-[2]`), or the textarea would swallow the clicks. */
export function ComposerActions({ children }: { children: ReactNode }) {
  return <div className="absolute right-2 top-1/2 z-[3] flex -translate-y-1/2 items-center gap-2">{children}</div>
}

/** The bottom row inside the box. */
export function ComposerFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-composer-row className={cn('flex flex-wrap items-center gap-2 px-2 pb-2', className)}>
      {children}
    </div>
  )
}

interface ComposerSendButtonProps {
  /** Renders `aria-disabled`, never native `disabled`, so the button keeps focus and its tooltip. */
  blocked: boolean
  /** Applies the shared dimmed look while blocked; false when the field block already dims. */
  dimWhenBlocked?: boolean
  /** Sets `aria-busy` while a send is being started or awaited. */
  busy?: boolean
  onSend: () => void
  tooltip: ReactNode
  keyShortcuts?: string
  /** Id of visible text naming why Send is blocked. */
  describedBy?: string
}

/** Round icon Send. Its `--send` fill overrides the default variant's `--primary`, which is
 * near-white in Dark and would read the same as Stop's inverted fill. */
export function ComposerSendButton({ blocked, busy, dimWhenBlocked = true, onSend, tooltip, keyShortcuts, describedBy }: ComposerSendButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="default"
          size="icon-sm"
          className={cn(
            'rounded-full bg-send text-send-foreground hover:bg-[color-mix(in_oklch,var(--send),var(--background)_15%)] aria-disabled:hover:bg-send',
            dimWhenBlocked && COMPOSER_DISABLED_OPACITY_CLASS,
            COMPOSER_BUTTON_FOCUS_CLASS
          )}
          aria-label="Send message"
          aria-keyshortcuts={keyShortcuts}
          aria-disabled={blocked}
          aria-busy={busy || undefined}
          // Only when set: Radix wires the open tooltip into aria-describedby otherwise.
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          onClick={() => {
            if (blocked) return
            onSend()
          }}
        >
          <ArrowUpIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

interface ComposerStopButtonProps {
  label: string
  /** Tooltip content: a shortcut as `Kbd`s, or plain text. */
  tooltip: ReactNode
  keyShortcuts?: string
  onClick: () => void
  onFocus?: () => void
  onBlur?: () => void
}

/** Round Stop. A solid neutral fill, never red: stopping keeps the work. `fill-current` makes the
 * outline-only square glyph read as a solid stop. */
export function ComposerStopButton({ label, tooltip, keyShortcuts, onClick, onFocus, onBlur }: ComposerStopButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="invert"
          size="icon-sm"
          className={cn('rounded-full', COMPOSER_BUTTON_FOCUS_CLASS)}
          aria-label={label}
          aria-keyshortcuts={keyShortcuts}
          onClick={onClick}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <SquareIcon className="fill-current" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
