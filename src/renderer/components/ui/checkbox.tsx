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
export const CHECKBOX_BOX_CLASS = "grid size-4 shrink-0 place-items-center rounded-sm border border-muted-foreground"

export { CheckboxItem, CheckboxIndicator }
