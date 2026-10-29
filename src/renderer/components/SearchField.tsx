// Shared search/filter field (docs/design/components.md "Reusable components first", #934
// decision 5): a leading magnifier, Esc-clears, and a clear (x) button that appears only once
// there is text to clear. First built here for issue #559 (the session list's own search); #934
// is expected to reuse this same component for the Manage sessions screen's own search input
// rather than fork it -- extend with a prop when that story needs more, per the HARD RULE in
// AGENTS.md ("Reusable UI components").
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
  /** The input's own accessible name (`aria-label`); says what the field searches, since the
   *  visible placeholder alone is not read by every screen reader once the field has focus. */
  label: string
  placeholder: string
  /** Which side the clear button's tooltip opens on; a narrow host (the 220px-minimum session
   *  list) needs `"right"` so the tooltip clears its own neighbours. */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Overrides what the clear button is called (accessible name and tooltip); default "Clear filter". */
  clearLabel?: string
  /** Replaces Esc-clears: when given, Esc anywhere in the field calls this instead (a find bar
   *  that closes on Esc, say), and the Esc hints are not shown. */
  onEscape?(): void
  /** Called on Enter in the input (not while composing text), with whether Shift was held. */
  onSubmit?(shift: boolean): void
  /** Applied to the field's own wrapper, never the `<input>` directly -- a caller that needs a
   *  landmark role or a width override wraps or classes this component from outside instead of
   *  it owning one itself (#559 decision 3: the `role="search"` region lives at the call site,
   *  so a future toolbar can embed this field without nesting a second landmark). */
  className?: string
  inputRef?: RefObject<HTMLInputElement | null>
  /** Makes the input the combobox half of a combobox + listbox pair (`FilterableGroupedListbox`): role=combobox with these attributes instead of searchbox. */
  combobox?: { listboxId: string; activeDescendantId?: string }
  /** Runs first for a keydown on the input; preventDefault() skips this field's own Enter/Esc handling. */
  onInputKeyDown?(event: KeyboardEvent<HTMLInputElement>): void
  /** Gate round 1 fix (code-reviewer Medium): extra attributes spread onto the `<input>` itself
   *  (for example a stable `data-*` hook), so a caller never has to find this field by its
   *  wrapper's own descendant structure -- #934's own future `ListToolbar` embedding could
   *  change that structure. Gate round 3 fix (finding 10, extended gate round 5, Main's finding
   *  5): the props every behaviour above depends on are omitted from what a caller can pass, so
   *  a future `onKeyDown`/`role`/`className`/`value`/`onChange`/`type`/`aria-label`/
   *  `aria-labelledby`/`aria-describedby` here can never silently remove Esc-clears, the
   *  field's own accessible name, or the Clear-hint wiring -- the component itself owns those,
   *  always.
   */
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

  // One clear path (#559 decision 11): the button and Esc both call this, and it always returns
  // focus to the field -- never leaving focus stranded on an unmounting clear button.
  function clear(): void {
    onValueChange('')
    resolvedRef.current?.focus()
  }

  // Gate round 3 fix (ui-architect-v3 Low, finding 9): attached to the WRAPPER, not just the
  // `<input>` -- Esc while the in-field Clear button has focus used to do nothing (the handler
  // only ever saw keydowns that landed directly on the input itself); a keydown on either child
  // element bubbles to this div, so Esc now clears from both.
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
        // Issue #559 decision 28 (gate round 3 correction, ui-visual-system-v3 Medium): `Input`'s
        // own default fill (`bg-transparent dark:bg-input/30`) is kept -- an earlier "fix" here
        // forced it opaque based on a wrong contrast reading. `--input` is ITSELF translucent
        // (36% in Dark/Obsidian, 38% in Dark high contrast, `globals.css`'s own border-floor
        // comment), so `dark:bg-input/30` composites at `input's own alpha * 0.3` (roughly 11%
        // white over `--sidebar`), not a flat 30% -- the field's `muted-foreground` text and
        // icons measure roughly 5.1:1 (Dark), 5.2:1 (Obsidian) and 10.3:1 (Dark high contrast)
        // against that real composited fill, comfortably over the 4.5:1 floor. Gated by the
        // `search-field (input*0.3 on sidebar)` pair in `scripts/check-theme-contrast.mjs`
        // (`theme-contrast-pairs.mjs`'s own `searchFieldContrastRows`), not a token this field
        // invents -- SearchField stays on the one Input-fill convention every other text field
        // in the app already uses, rather than starting a second, opaque one.
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
              // Gate-fix precedent (GroupHeader.tsx's own `describedByPath`): an explicit
              // `undefined` here wins over Radix's own injected `aria-describedby` (the Slot
              // merge), so the Tooltip's text is never read twice over for this button.
              aria-describedby={undefined}
              // Not centred with `top-1/2 -translate-y-1/2`: `Button`'s own base
              // `active:not-aria-[haspopup]:translate-y-px` would then fight that transform on
              // every press. `top-1` centres a 24px target in this 32px field with no transform.
              //
              // Gate round 1 fix (ui-visual-system-v3 Medium): `COMPOSER_BUTTON_FOCUS_CLASS`'s
              // own `outline-offset-2` pushes the ring onto (and partly past) the field's 1px
              // border at this button's 4px inset, measuring under 3:1 on that side -- an
              // explicit `outline-offset-0` after it wins the same CSS property.
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
