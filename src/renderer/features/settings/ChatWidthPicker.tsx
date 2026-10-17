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
  { id: 'full', name: 'Full', description: 'The transcript fills the pane.' },
  { id: 'reading-column', name: 'Reading column', description: 'The transcript caps at a comfortable width, centred.' }
]

export function ChatWidthPicker() {
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
    <div role="radiogroup" aria-label="Chat width" className="flex flex-col gap-1">
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
            tabIndex={isActive ? 0 : -1}
            onClick={() => choose(option.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'flex w-full flex-col items-start gap-0.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <span className="flex w-full items-center gap-2.5">
              <span className="flex-1">{option.name}</span>
              {isActive && (
                <span className="flex items-center gap-1 text-xs">
                  <CheckIcon aria-hidden className="size-3.5" />
                  <span>Current</span>
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{option.description}</span>
          </button>
        )
      })}
    </div>
  )
}
