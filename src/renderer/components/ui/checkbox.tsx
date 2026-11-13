import * as React from "react"
import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

function CheckboxItem({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox-item"
      className={cn(
        "group/checkbox-item flex w-full min-w-0 flex-col items-start gap-1 rounded-lg border border-border bg-background px-4 py-2 text-left text-sm outline-none focus-visible:outline-hidden transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary/5 forced-colors:data-[state=checked]:border-[Highlight]",
        className
      )}
      {...props}
    />
  )
}

function CheckboxIndicator({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Indicator>) {
  return (
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      className={cn("flex items-center justify-center text-foreground forced-colors:text-[CanvasText]", className)}
      {...props}
    >
      <CheckIcon aria-hidden className="size-4" />
    </CheckboxPrimitive.Indicator>
  )
}

export const CHECKBOX_LIST_ITEM_CLASS =
  "min-h-6 flex-row items-center gap-2 rounded-none border-none bg-transparent px-0 py-0 hover:bg-transparent data-[state=checked]:border-none data-[state=checked]:bg-transparent"
// Question-card option row (#1434): a fill, not a border; the dot or tick shows the pick. Transparent border keeps a forced-colors edge.
export const OPTION_FILL_CLASS =
  "border-transparent bg-muted hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)] dark:border-transparent dark:bg-muted dark:hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]"
// Busy rows keep their resting fill on hover, so they do not look pressable. Literal classes: Tailwind cannot see interpolated ones.
const OPTION_BUSY_HOVER =
  "aria-disabled:hover:bg-muted dark:aria-disabled:hover:bg-muted aria-disabled:data-[state=checked]:hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)] dark:aria-disabled:data-[state=checked]:hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]"
const OPTION_LAYOUT_CLASS =
  "grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 min-h-9 py-1 aria-disabled:opacity-50 data-[state=checked]:border-transparent focus-visible:border-transparent forced-colors:data-[state=checked]:border-[Highlight]"
export const OPTION_ROW_CLASS =
  OPTION_FILL_CLASS + " " + OPTION_BUSY_HOVER + " " + OPTION_LAYOUT_CLASS + " data-[state=checked]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]"
// A question's recommended option (#1985): the `--severity-success-bg` tint. The icon and "Recommended" text, not this tint, carry the meaning.
// The tint survives the checked state and hover (a 5% foreground mix is the cue), so the base `hover:bg-muted` and `data-[state=checked]:bg-primary/5` are overridden here.
export const OPTION_RECOMMENDED_FILL_CLASS =
  "border-transparent bg-severity-success-bg hover:bg-[color-mix(in_oklch,var(--severity-success-bg),var(--foreground)_5%)] data-[state=checked]:bg-severity-success-bg data-[state=checked]:hover:bg-[color-mix(in_oklch,var(--severity-success-bg),var(--foreground)_5%)] dark:border-transparent dark:bg-severity-success-bg dark:hover:bg-[color-mix(in_oklch,var(--severity-success-bg),var(--foreground)_5%)] dark:data-[state=checked]:bg-severity-success-bg dark:data-[state=checked]:hover:bg-[color-mix(in_oklch,var(--severity-success-bg),var(--foreground)_5%)]"
// Busy rows keep their resting tint on hover, like `OPTION_BUSY_HOVER`.
const RECOMMENDED_BUSY_HOVER =
  "aria-disabled:hover:bg-severity-success-bg dark:aria-disabled:hover:bg-severity-success-bg aria-disabled:data-[state=checked]:hover:bg-severity-success-bg dark:aria-disabled:data-[state=checked]:hover:bg-severity-success-bg"
export const OPTION_RECOMMENDED_ROW_CLASS = OPTION_RECOMMENDED_FILL_CLASS + " " + RECOMMENDED_BUSY_HOVER + " " + OPTION_LAYOUT_CLASS
/** Mark column for an option row: centred on the whole row, spanning label and description. */
export const OPTION_MARK_CLASS = "row-span-2 self-center"
export const CHECKBOX_BOX_CLASS = "grid size-4 shrink-0 place-items-center rounded-sm border border-muted-foreground"

export { CheckboxItem, CheckboxIndicator }
