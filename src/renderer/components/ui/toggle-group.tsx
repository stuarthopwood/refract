import * as React from "react"
import { type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { toggleVariants } from "@/components/ui/toggle"

// The Tabs look (TAB_LOOK_CLASS in tabs.tsx) keyed off the toggle's own state. The Toggle base
// fills pressed/checked/on items with `primary`, so every state variant is cleared here.
const OPTION_LOOK_CLASS =
  "relative shrink-0 rounded-none border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground aria-pressed:bg-transparent aria-pressed:text-foreground aria-pressed:hover:bg-transparent aria-checked:bg-transparent aria-checked:text-foreground aria-checked:hover:bg-transparent data-[state=on]:bg-transparent data-[state=on]:text-foreground data-[state=on]:hover:bg-transparent data-[state=on]:after:absolute data-[state=on]:after:inset-x-2 data-[state=on]:after:bottom-0 data-[state=on]:after:h-0.5 data-[state=on]:after:rounded-sm data-[state=on]:after:bg-accent-text forced-colors:data-[state=on]:border-[Highlight] forced-colors:data-[state=on]:after:hidden"

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  spacing: 1,
  orientation: "horizontal",
})

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 1,
  orientation = "horizontal",
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-orientation={orientation}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[size=sm]:rounded-md data-vertical:flex-col data-vertical:items-stretch",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider
        value={{ variant, size, spacing, orientation }}
      >
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        OPTION_LOOK_CLASS,
        className
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem }
