// Hand-rolled radiogroup like ThemePicker: arrows save the choice, unlike the shared radio-group primitive (#554).
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { RADIO_DOT_CLASS, RADIO_RING_CLASS } from '@/components/ui/radio-group'
import { useActiveChatWidth, useChatWidthStore } from '@/state'
import type { ChatWidth } from '../../../shared/chatWidth'

const CHAT_WIDTH_OPTIONS: ReadonlyArray<{ id: ChatWidth; name: string; description: string }> = [
  { id: 'full', name: 'Full', description: 'Default. The transcript fills the pane.' },
  { id: 'reading-column', name: 'Reading column', description: 'The transcript caps at a comfortable width, centred.' }
]

interface ChatWidthPickerProps {
  /** Ids of the heading and hint rendered in AppearanceSection. */
  labelledBy: string
  describedBy: string
}

export function ChatWidthPicker({ labelledBy, describedBy }: ChatWidthPickerProps) {
  const activeId = useActiveChatWidth()
  const save = useChatWidthStore((state) => state.save)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  function choose(id: ChatWidth) {
    if (id === activeId) return
    void save(id)
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
    <div className="max-w-sm">
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
              data-state={isActive ? 'checked' : 'unchecked'}
              aria-labelledby={`chat-width-option-${option.id}-name`}
              aria-describedby={`chat-width-option-${option.id}-desc`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => choose(option.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                'group/radio-item flex w-full flex-col items-start gap-1 rounded-md border border-transparent py-2 pr-8 pl-2 text-left text-sm outline-none',
                'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-glow',
                isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-row-hover-bg hover:text-foreground'
              )}
            >
              <span className="flex w-full items-center gap-2">
                <span aria-hidden className={RADIO_RING_CLASS}>
                  {isActive && <span className={RADIO_DOT_CLASS} />}
                </span>
                <span id={`chat-width-option-${option.id}-name`} className="flex-1">{option.name}</span>
              </span>
              <span id={`chat-width-option-${option.id}-desc`} className="pl-6 text-xs text-muted-foreground">{option.description}</span>
            </button>
          )
        })}
      </div>
      {/* Preview tile driven by activeId so it tracks the saved choice. */}
      <div aria-hidden className="mt-2 w-full max-w-56 rounded-md border border-border bg-surface-subtle p-2">
        <div data-chat-width-preview-bars className={cn('mx-auto flex flex-col gap-1', activeId === 'reading-column' && 'w-2/3')}>
          <div className="h-1.5 w-full rounded-full bg-preview-bar-bg" />
          <div className="h-1.5 w-5/6 rounded-full bg-preview-bar-bg" />
          <div className="h-1.5 w-full rounded-full bg-preview-bar-bg" />
        </div>
      </div>
    </div>
  )
}
