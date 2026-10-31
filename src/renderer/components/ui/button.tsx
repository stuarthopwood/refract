import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { LoaderCircleIcon } from "lucide-react"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2 active:not-aria-[haspopup]:not-aria-disabled:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-invalid-ring dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground not-aria-disabled:hover:bg-primary-hover-bg",
        // Solid neutral, never red: stopping a turn keeps the work. Hover mixes 15% background
        // (no token exists for this mix).
        invert: "bg-foreground text-background not-aria-disabled:hover:bg-[color-mix(in_oklch,var(--foreground),var(--background)_15%)]",
        outline:
          "border-button-outline-border bg-button-outline-bg text-button-outline-fg not-aria-disabled:hover:bg-button-outline-hover-bg aria-expanded:bg-button-outline-hover-bg",
        secondary:
          "bg-button-secondary-bg text-button-secondary-fg not-aria-disabled:hover:bg-button-secondary-hover-bg aria-expanded:bg-button-secondary-bg aria-expanded:text-button-secondary-fg",
        ghost:
          "not-aria-disabled:hover:bg-muted not-aria-disabled:hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground not-aria-disabled:dark:hover:bg-row-hover-bg font-normal",
        destructive:
          "bg-button-destructive-bg text-button-destructive-fg not-aria-disabled:hover:bg-button-destructive-hover-bg focus-visible:border-destructive/40 focus-visible:ring-destructive/80",
        // Borderless, red label: a destructive action that must not compete with the surface's one filled button (#1387).
        "ghost-destructive":
          "text-destructive not-aria-disabled:hover:bg-muted not-aria-disabled:hover:text-destructive aria-expanded:bg-muted not-aria-disabled:dark:hover:bg-row-hover-bg font-normal",
        link: "text-primary underline underline-offset-4 font-normal",
        // Non-primary action beside an `outline` primary (#746); underlines on hover and focus, with a ring since it has no border.
        text: "min-h-6 rounded-md text-foreground not-aria-disabled:hover:underline focus-visible:underline focus-visible:ring-2 underline-offset-2",
        // Same shape as `text`, red label, for actions that open a confirm dialog.
        "text-destructive":
          "min-h-6 rounded-md text-destructive not-aria-disabled:hover:underline focus-visible:underline focus-visible:ring-2 underline-offset-2",
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
    /** Shows a spinner before the label, sets aria-busy and aria-disabled (not `disabled`, so focus stays) and blocks clicks. Ignored with `asChild`. */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }), loading && !asChild && "opacity-50")}
      {...(loading && !asChild ? { "aria-busy": true, "aria-disabled": true, disabled } : { disabled })}
      {...props}
      onClick={loading && !asChild ? (e) => e.preventDefault() : props.onClick}
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
