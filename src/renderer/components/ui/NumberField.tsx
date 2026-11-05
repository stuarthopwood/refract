import * as React from "react"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// `type="number"` also accepts these, which no whole-number setting wants.
const BLOCKED_KEYS: Record<string, true> = { e: true, E: true, "+": true, "-": true }

// The native spinner cannot be themed or spaced, so it is hidden and replaced by the chevrons below.
const HIDE_NATIVE_SPINNER =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none"

const STEP_BUTTON = "h-auto min-h-0 w-4 flex-1 rounded-sm p-0 text-muted-foreground hover:bg-transparent hover:text-foreground active:text-foreground dark:hover:bg-transparent [&_svg]:size-3"

/** `value` as a number, or `undefined` when empty or not controlled. */
function numericValue(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** A number input with muted chevron step buttons, 8px clear of the value, and ArrowUp/ArrowDown stepping from `min`, `step` and `max`.
 * Blocks exponent and sign keys, and blurs on wheel so scrolling a page never edits a focused value. */
function NumberField({ className, onKeyDown, onWheel, ref, ...props }: Omit<React.ComponentProps<typeof Input>, "type">) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const setRefs = (node: HTMLInputElement | null): void => {
    inputRef.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }

  // Stepping the DOM node and firing `input` makes `onChange` run exactly as typing does.
  const step = (direction: 1 | -1): void => {
    const input = inputRef.current
    if (!input) return
    if (direction > 0) input.stepUp()
    else input.stepDown()
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  const inert = Boolean(props.disabled || props.readOnly)
  const value = numericValue(props.value)
  const min = numericValue(props.min)
  const max = numericValue(props.max)
  const atMax = value !== undefined && max !== undefined && value >= max
  const atMin = value !== undefined && min !== undefined && value <= min

  return (
    <div data-slot="number-field-root" className="relative inline-flex">
      <Input
        ref={setRefs}
        type="number"
        data-slot="number-field"
        className={cn(HIDE_NATIVE_SPINNER, "pr-6", className)}
        onKeyDown={(event) => {
          if (!(event.ctrlKey || event.metaKey || event.altKey) && BLOCKED_KEYS[event.key]) event.preventDefault()
          onKeyDown?.(event)
        }}
        onWheel={(event) => {
          event.currentTarget.blur()
          onWheel?.(event)
        }}
        {...props}
      />
      <div className="absolute inset-y-px right-px flex flex-col">
        <Button type="button" variant="ghost" tabIndex={-1} aria-hidden disabled={inert || atMax} className={STEP_BUTTON} onClick={() => step(1)}>
          <ChevronUpIcon />
        </Button>
        <Button type="button" variant="ghost" tabIndex={-1} aria-hidden disabled={inert || atMin} className={STEP_BUTTON} onClick={() => step(-1)}>
          <ChevronDownIcon />
        </Button>
      </div>
    </div>
  )
}

export { NumberField }
