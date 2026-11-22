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
// Question-card option row (#1434): a fill, not a border. Resting is `--muted`, hover a neutral 5% foreground mix, and a pick (#2027) a
// `--primary`-tinted fill plus a left edge, so hover and selected never share a fill. Transparent border keeps a forced-colors edge.
export const OPTION_FILL_CLASS =
  "border-transparent bg-muted hover:bg-option-hover-bg dark:border-transparent dark:bg-muted dark:hover:bg-option-hover-bg"
// Busy rows keep their resting fill on hover, so they do not look pressable. Literal classes: Tailwind cannot see interpolated ones.
const OPTION_BUSY_HOVER =
  "aria-disabled:hover:bg-muted dark:aria-disabled:hover:bg-muted aria-disabled:data-[state=checked]:hover:bg-option-selected-bg"
// The left edge is an inset shadow, so it composes with the focus ring's own box-shadow layers; forced colors drops shadows and uses the Highlight border.
const OPTION_LAYOUT_CLASS =
  "grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 min-h-9 py-1 aria-disabled:opacity-50 data-[state=checked]:border-transparent data-[state=checked]:shadow-[inset_2px_0_0_0_var(--primary)] focus-visible:border-transparent forced-colors:data-[state=checked]:border-[Highlight]"
export const OPTION_ROW_CLASS =
  OPTION_FILL_CLASS + " " + OPTION_BUSY_HOVER + " " + OPTION_LAYOUT_CLASS + " data-[state=checked]:bg-option-selected-bg data-[state=checked]:hover:bg-option-selected-bg"
// A question's recommended option (#1985): the `--severity-success-bg` tint. The icon and "Recommended" text, not this tint, carry the meaning.
// The tint survives the checked state and hover (`--color-severity-success-hover-bg`, a 5% foreground mix, is the cue), so the base `hover:bg-muted` and `data-[state=checked]:bg-primary/5` are overridden here.
// The mix is a theme token, not a `color-mix(` here: the literal-colours gate counts those, and its baseline may not grow.
export const OPTION_RECOMMENDED_FILL_CLASS =
  "border-transparent bg-severity-success-bg hover:bg-severity-success-hover-bg data-[state=checked]:bg-severity-success-bg data-[state=checked]:hover:bg-severity-success-hover-bg dark:border-transparent dark:bg-severity-success-bg dark:hover:bg-severity-success-hover-bg dark:data-[state=checked]:bg-severity-success-bg dark:data-[state=checked]:hover:bg-severity-success-hover-bg"
// Busy rows keep their resting tint on hover, like `OPTION_BUSY_HOVER`.
const RECOMMENDED_BUSY_HOVER =
  "aria-disabled:hover:bg-severity-success-bg dark:aria-disabled:hover:bg-severity-success-bg aria-disabled:data-[state=checked]:hover:bg-severity-success-bg dark:aria-disabled:data-[state=checked]:hover:bg-severity-success-bg"
export const OPTION_RECOMMENDED_ROW_CLASS = OPTION_RECOMMENDED_FILL_CLASS + " " + RECOMMENDED_BUSY_HOVER + " " + OPTION_LAYOUT_CLASS
/** Mark column for an option row: centred on the whole row, spanning label and description. */
export const OPTION_MARK_CLASS = "row-span-2 self-center"
export const CHECKBOX_BOX_CLASS = "grid size-4 shrink-0 place-items-center rounded-sm border border-muted-foreground"
// `CheckboxItem` is a full-row button, so a row holding other controls passes this to shrink it to the box alone.
// Its own ring is lighter, and a busy or locked box reads as inert (dimmed, no pointer) while a live one answers hover.
export const CHECKBOX_BOX_ONLY_CLASS = [
  CHECKBOX_BOX_CLASS,
  "gap-0 bg-transparent p-0 hover:bg-transparent hover:border-foreground data-[state=checked]:border-muted-foreground data-[state=checked]:bg-transparent",
  "focus-visible:border-muted-foreground focus-visible:ring-2",
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:border-muted-foreground"
].join(" ")

export { CheckboxItem, CheckboxIndicator }
