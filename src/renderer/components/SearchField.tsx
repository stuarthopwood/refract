import { useId, useRef } from 'react'
import type { InputHTMLAttributes, KeyboardEvent, RefObject } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { cn } from '@/lib/utils'

export interface SearchFieldProps {
  value: string
  onValueChange(value: string): void
  label: string
  placeholder: string
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  clearLabel?: string
  /** Replaces Esc-clears: when given, Esc anywhere in the field calls this instead (a find bar that closes on Esc, say), and the Esc hints are not shown. */
  onEscape?(): void
  /** Called on Enter in the input (not while composing text), with whether Shift was held. */
  onSubmit?(shift: boolean): void
  /** Applied to the field's own wrapper, never the `<input>` directly. */
  className?: string
  inputRef?: RefObject<HTMLInputElement | null>
  combobox?: { listboxId: string; activeDescendantId?: string }
  onInputKeyDown?(event: KeyboardEvent<HTMLInputElement>): void
  inputProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'onKeyDown' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'role' | 'className' | 'type'
  > & {
    [attribute: `data-${string}`]: string
  }
}

export function SearchField({
  value,
  onValueChange,
  label,
  placeholder,
  tooltipSide = 'top',
  clearLabel = 'Clear filter',
  onEscape,
  onSubmit,
  className,
  inputRef,
  combobox,
  onInputKeyDown,
  inputProps
}: SearchFieldProps) {
  const localRef = useRef<HTMLInputElement>(null)
  const resolvedRef = inputRef ?? localRef
  const hasValue = value !== ''
  const clearHintId = useId()

  function clear(): void {
    onValueChange('')
    resolvedRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return
    if (onInputKeyDown && event.target instanceof HTMLInputElement) {
      onInputKeyDown(event as unknown as KeyboardEvent<HTMLInputElement>)
      if (event.defaultPrevented) return
    }
    if (event.key === 'Enter' && onSubmit && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      onSubmit(event.shiftKey)
      return
    }
    if (event.key !== 'Escape') return
    if (onEscape) {
      event.preventDefault()
      event.stopPropagation()
      onEscape()
      return
    }
    if (!hasValue) return
    event.preventDefault()
    event.stopPropagation()
    clear()
  }

  return (
    <div className={cn('relative', className)} onKeyDown={handleKeyDown}>
      <SearchIcon aria-hidden className="pointer-events-none absolute left-[9px] top-2 size-4 text-muted-foreground" />
      <Input
        ref={resolvedRef}
        type="text"
        role={combobox ? 'combobox' : 'searchbox'}
        aria-autocomplete={combobox ? 'list' : undefined}
        aria-expanded={combobox ? true : undefined}
        aria-controls={combobox?.listboxId}
        aria-activedescendant={combobox?.activeDescendantId}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={hasValue && !onEscape ? clearHintId : undefined}
        className="h-8 pl-8 pr-8 text-sm forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-1"
        {...inputProps}
      />
      {hasValue && !onEscape && (
        <span id={clearHintId} className="sr-only">
          Press Escape to clear
        </span>
      )}
      {hasValue && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={clearLabel}
              aria-describedby={undefined}
              // Not centred with `top-1/2 -translate-y-1/2`.
              className={cn(
                'absolute right-1 top-1 text-muted-foreground hover:text-foreground',
                COMPOSER_BUTTON_FOCUS_CLASS,
                'focus-visible:outline-offset-0'
              )}
              onClick={clear}
            >
              <XIcon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide}>
            <span className="inline-flex items-center gap-2">
              {clearLabel}
              {!onEscape && (
                <KbdGroup>
                  <Kbd>Esc</Kbd>
                </KbdGroup>
              )}
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
