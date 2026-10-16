// Shared search/filter field (docs/design/components.md "Reusable components first", #934
// decision 5): a leading magnifier, Esc-clears, and a clear (x) button that appears only once
// there is text to clear. First built here for issue #559 (the session list's own search); #934
// is expected to reuse this same component for the Manage sessions screen's own search input
// rather than fork it -- extend with a prop when that story needs more, per the HARD RULE in
// AGENTS.md ("Reusable UI components").
import { useId, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
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
  /** The input's own accessible name (`aria-label`); says what the field searches, since the
   *  visible placeholder alone is not read by every screen reader once the field has focus. */
  label: string
  placeholder: string
  /** Which side the clear button's tooltip (and the field's own) opens on; a narrow host (the
   *  220px-minimum session list) needs `"right"` so the tooltip clears its own neighbours. */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Applied to the field's own wrapper, never the `<input>` directly -- a caller that needs a
   *  landmark role or a width override wraps or classes this component from outside instead of
   *  it owning one itself (#559 decision 3: the `role="search"` region lives at the call site,
   *  so a future toolbar can embed this field without nesting a second landmark). */
  className?: string
  inputRef?: RefObject<HTMLInputElement | null>
}

export function SearchField({ value, onValueChange, label, placeholder, tooltipSide = 'top', className, inputRef }: SearchFieldProps) {
  const localRef = useRef<HTMLInputElement>(null)
  const resolvedRef = inputRef ?? localRef
  const hasValue = value !== ''
  const clearHintId = useId()

  // One clear path (#559 decision 11): the button and Esc both call this, and it always returns
  // focus to the field -- never leaving focus stranded on an unmounting clear button.
  function clear(): void {
    onValueChange('')
    resolvedRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Escape' || !hasValue || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    clear()
  }

  return (
    <div className={cn('relative', className)}>
      <SearchIcon aria-hidden className="pointer-events-none absolute left-[9px] top-2 size-4 text-muted-foreground" />
      <Input
        ref={resolvedRef}
        type="text"
        role="searchbox"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={hasValue ? clearHintId : undefined}
        className="h-8 pl-8 pr-8 text-sm forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-1"
      />
      {hasValue && (
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
              aria-label="Clear filter"
              // Gate-fix precedent (GroupHeader.tsx's own `describedByPath`): an explicit
              // `undefined` here wins over Radix's own injected `aria-describedby` (the Slot
              // merge), so the Tooltip's text is never read twice over for this button.
              aria-describedby={undefined}
              // Not centred with `top-1/2 -translate-y-1/2`: `Button`'s own base
              // `active:not-aria-[haspopup]:translate-y-px` would then fight that transform on
              // every press. `top-1` centres a 24px target in this 32px field with no transform.
              className={cn('absolute right-1 top-1 text-muted-foreground hover:text-foreground', COMPOSER_BUTTON_FOCUS_CLASS)}
              onClick={clear}
            >
              <XIcon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide}>
            <span className="inline-flex items-center gap-1.5">
              Clear filter
              <KbdGroup>
                <Kbd>Esc</Kbd>
              </KbdGroup>
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
