// Issue #554 (amends FR-049, new FR-073): a keyboard-operable chat width picker, reusing
// `ThemePicker.tsx`'s own hand-rolled `role="radiogroup"`/`role="radio"` roving-tabindex pattern
// unchanged (ui-architect-v3 roundtable, Decided, Skippy, delegated by Stuart 2026-10-18) -- the
// issue asks for exactly ThemePicker's live-preview-on-arrow interaction model, not merely its
// visual shape, so the shared `components/ui/radio-group.tsx` primitive (Space-selects,
// Home/End-move-focus-only) is the wrong precedent to copy here, same as it was for ThemePicker
// itself. Two entries instead of three; otherwise identical structure.
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { CheckIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useActiveChatWidth, useChatWidthStore } from '@/state'
import type { ChatWidth } from '../../../shared/chatWidth'

const CHAT_WIDTH_OPTIONS: ReadonlyArray<{ id: ChatWidth; name: string; description: string }> = [
  { id: 'full', name: 'Full', description: 'Default. The transcript fills the pane.' },
  { id: 'reading-column', name: 'Reading column', description: 'The transcript caps at a comfortable width, centred.' }
]

interface ChatWidthPickerProps {
  /** Issue #554 gate round 2 (L1): same accessible-name/description wiring as
   * `ThemePicker`'s own group -- the heading and hint `<p>` both live in
   * `AppearanceSection.tsx`, this group only points at their ids. */
  labelledBy: string
  describedBy: string
}

export function ChatWidthPicker({ labelledBy, describedBy }: ChatWidthPickerProps) {
  const activeId = useActiveChatWidth()
  const preview = useChatWidthStore((state) => state.preview)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  // FR-002/FR-006 deviation note (2a, carried over from ThemePicker): choosing the already-active
  // entry is a deliberate no-op -- it never re-fires `preview` for nothing.
  function choose(id: ChatWidth) {
    if (id === activeId) return
    preview(id)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = Math.min(index + 1, CHAT_WIDTH_OPTIONS.length - 1)
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = Math.max(index - 1, 0)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = CHAT_WIDTH_OPTIONS.length - 1
    if (nextIndex === null) return
    const nextOption = CHAT_WIDTH_OPTIONS[nextIndex]
    if (!nextOption) return
    event.preventDefault()
    choose(nextOption.id)
    buttonRefs.current[nextIndex]?.focus()
  }

  return (
    <>
      <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex flex-col gap-1">
        {CHAT_WIDTH_OPTIONS.map((option, index) => {
          const isActive = option.id === activeId
          return (
            <button
              key={option.id}
              ref={(node) => {
                buttonRefs.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-labelledby={`chat-width-option-${option.id}-name`}
              aria-describedby={`chat-width-option-${option.id}-desc`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => choose(option.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                'flex w-full flex-col items-start gap-1 rounded-md border border-transparent px-2 py-2 text-left text-sm outline-none',
                'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              <span className="flex w-full items-center gap-2">
                {/* L4: an aria-hidden size-4 slot so this group's labels align with Theme's own
                    swatch-led rows -- Chat width has no per-option colour, so this stays empty. */}
                <span aria-hidden className="size-4 shrink-0" />
                <span id={`chat-width-option-${option.id}-name`} className="flex-1">{option.name}</span>
                {isActive && (
                  <span aria-hidden className="flex items-center gap-1 text-xs">
                    <CheckIcon aria-hidden className="size-3.5" />
                    <span>Current</span>
                  </span>
                )}
              </span>
              <span id={`chat-width-option-${option.id}-desc`} className="text-xs text-muted-foreground">{option.description}</span>
            </button>
          )
        })}
      </div>
      {/* H2 gate fix: a small aria-hidden preview tile, modelled on `BrandWatermark`'s own
          'preview' variant -- live-driven by `activeId` (NOT a separate store read, so it
          updates on every arrow/click the instant `useActiveChatWidth()` does, same as the
          radio rows above it) so the chosen width is shown, not just named, before Save. */}
      <div aria-hidden className="mt-2 w-full max-w-56 rounded-md border border-border bg-muted/30 p-2">
        <div data-chat-width-preview-bars className={cn('mx-auto flex flex-col gap-1', activeId === 'reading-column' && 'w-2/3')}>
          <div className="h-1.5 w-full rounded-full bg-muted-foreground/40" />
          <div className="h-1.5 w-5/6 rounded-full bg-muted-foreground/40" />
          <div className="h-1.5 w-full rounded-full bg-muted-foreground/40" />
        </div>
      </div>
    </>
  )
}
