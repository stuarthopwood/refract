import { useId, useRef } from 'react'
import type { InputHTMLAttributes, KeyboardEvent, ReactElement, RefObject } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'
import { InputActionButton, InputWithAction } from '@/components/ui/input-with-action'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { FILTER_MIN_CHARS, FILTER_MIN_CHARS_HINT } from '@/components/filterQueryRule'

export interface SearchFieldProps {
  value: string
  onValueChange(value: string): void
  label: string
  placeholder: string
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  clearLabel?: string
  /** Opts out of the three-character rule (`filterQueryRule.ts`) for a type-ahead (the command palette) or a text search (find in chat); every list filter leaves it off and so states the rule. */
  instant?: boolean
  /** Replaces Esc-clears: when given, Esc anywhere in the field calls this instead (a find bar that closes on Esc, say), and the Esc hints are not shown. */
  onEscape?(): void
  /** Called on Enter in the input (not while composing text), with whether Shift was held. */
  onSubmit?(shift: boolean): void
  /** Applied to the field's own wrapper, never the `<input>` directly. */
  className?: string
  inputRef?: RefObject<HTMLInputElement | null>
  combobox?: { listboxId: string; activeDescendantId?: string }
  onInputKeyDown?(event: KeyboardEvent<HTMLInputElement>): void
  /** Replaces the `<input>`, which still gets the field's styling, `value` and label but keeps its own role and aria wiring. Give it its own change callback (a cmdk input's `onValueChange`), since it may ignore `onChange`. */
  input?: ReactElement
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
  instant = false,
  onEscape,
  onSubmit,
  className,
  inputRef,
  combobox,
  onInputKeyDown,
  inputProps,
  input
}: SearchFieldProps) {
  const localRef = useRef<HTMLInputElement>(null)
  const resolvedRef = inputRef ?? localRef
  const hasValue = value !== ''
  const clearHintId = useId()
  const ruleHintId = useId()
  const describedBy = [!instant ? ruleHintId : undefined, hasValue && !onEscape ? clearHintId : undefined].filter(Boolean).join(' ') || undefined

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
      <InputWithAction
        ref={resolvedRef}
        input={input}
        // A supplied `input` owns its own role and aria wiring (cmdk's combobox ids), which these would overwrite.
        {...(input
          ? {}
          : {
              type: 'text',
              role: combobox ? 'combobox' : 'searchbox',
              'aria-autocomplete': combobox ? 'list' : undefined,
              'aria-expanded': combobox ? true : undefined,
              'aria-controls': combobox?.listboxId,
              'aria-activedescendant': combobox?.activeDescendantId,
              autoComplete: 'off',
              spellCheck: false
            })}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={instant ? placeholder : `${placeholder} (${FILTER_MIN_CHARS}+ characters)`}
        aria-label={label}
        aria-describedby={describedBy}
        className="h-8 pl-8 text-sm forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-1"
        {...inputProps}
      >
        <SearchIcon aria-hidden className="pointer-events-none absolute left-[9px] top-2 size-4 text-muted-foreground" />
        {!instant && (
          <span id={ruleHintId} className="sr-only">
            {FILTER_MIN_CHARS_HINT}
          </span>
        )}
        {hasValue && !onEscape && (
          <span id={clearHintId} className="sr-only">
            Press Escape to clear
          </span>
        )}
        {hasValue && (
          <Tooltip>
            <TooltipTrigger asChild>
              <InputActionButton aria-label={clearLabel} onClick={clear}>
                <XIcon aria-hidden />
              </InputActionButton>
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
      </InputWithAction>
    </div>
  )
}
