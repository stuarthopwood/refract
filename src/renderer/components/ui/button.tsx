import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { LoaderCircleIcon } from "lucide-react"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-invalid-ring dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover-bg",
        // Solid neutral, never red: stopping a turn keeps the work. Hover mixes 15% background
        // (no token exists for this mix).
        invert: "bg-foreground text-background hover:bg-[color-mix(in_oklch,var(--foreground),var(--background)_15%)]",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-field-bg dark:hover:bg-field-hover-bg",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-row-hover-bg font-normal",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive-hover-bg focus-visible:border-destructive/40 focus-visible:ring-destructive/80",
        // Outlined at rest so the surface's one filled button stays the primary action; confirm dialogs use filled `destructive`.
        "destructive-outline":
          "border-destructive bg-background text-destructive hover:bg-muted hover:text-destructive aria-expanded:bg-muted dark:bg-field-bg dark:hover:bg-muted",
        // Borderless, red label: a destructive action that must not compete with the surface's one filled button (#1387).
        "ghost-destructive":
          "text-destructive hover:bg-muted hover:text-destructive aria-expanded:bg-muted dark:hover:bg-row-hover-bg font-normal",
        link: "text-primary underline underline-offset-4 font-normal",
        // Non-primary action beside an `outline` primary (#746); underlines on hover and focus, with a ring since it has no border.
        text: "min-h-6 rounded-md text-foreground hover:underline focus-visible:underline focus-visible:ring-2 underline-offset-2",
        // Same shape as `text`, red label, for actions that open a confirm dialog.
        "text-destructive":
          "min-h-6 rounded-md text-destructive hover:underline focus-visible:underline focus-visible:ring-2 underline-offset-2",
      },
      size: {
        default:
          "h-8 gap-2 px-2 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "min-h-6 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        sm: "min-h-6 gap-1 rounded-md px-2 text-compact in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        lg: "h-9 gap-2 px-2 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-4",
        "icon-sm":
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
        "icon-xl": "size-10 rounded-lg [&_svg:not([class*='size-'])]:size-6",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  children,
  disabled,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Shows a spinner before the label, sets aria-busy and disables the button. Ignored with `asChild`. */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...(loading && !asChild ? { "aria-busy": true, disabled: true } : { disabled })}
      {...props}
    >
      {loading && !asChild ? (
        <>
          <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
