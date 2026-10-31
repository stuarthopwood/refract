import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { LoaderCircleIcon } from "lucide-react"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2 active:not-aria-[haspopup]:not-aria-disabled:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed forced-colors:aria-disabled:text-[GrayText] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-invalid-ring dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // Each variant ends with an `aria-disabled:hover:` neutraliser: it outranks a caller's plain `hover:` override, so a busy button never looks clickable.
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover-bg aria-disabled:hover:bg-primary",
        // Solid neutral, never red: stopping a turn keeps the work. Hover mixes 15% background
        // (no token exists for this mix).
        invert: "bg-foreground text-background hover:bg-[color-mix(in_oklch,var(--foreground),var(--background)_15%)] aria-disabled:hover:bg-foreground",
        outline:
          "border-button-outline-border bg-button-outline-bg text-button-outline-fg hover:bg-button-outline-hover-bg aria-expanded:bg-button-outline-hover-bg aria-disabled:hover:bg-button-outline-bg",
        secondary:
          "bg-button-secondary-bg text-button-secondary-fg hover:bg-button-secondary-hover-bg aria-expanded:bg-button-secondary-bg aria-expanded:text-button-secondary-fg aria-disabled:hover:bg-button-secondary-bg",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-(--ghost-hover-bg,var(--row-hover-bg)) aria-disabled:hover:bg-transparent dark:aria-disabled:hover:bg-transparent font-normal",
        destructive:
          "bg-button-destructive-bg text-button-destructive-fg hover:bg-button-destructive-hover-bg focus-visible:border-destructive/40 focus-visible:ring-destructive/80 aria-disabled:hover:bg-button-destructive-bg",
        // Borderless, red label: a destructive action that must not compete with the surface's one filled button (#1387).
        "ghost-destructive":
          "text-destructive hover:bg-muted hover:text-destructive aria-expanded:bg-muted dark:hover:bg-(--ghost-hover-bg,var(--row-hover-bg)) aria-disabled:hover:bg-transparent dark:aria-disabled:hover:bg-transparent font-normal",
        link: "text-primary underline underline-offset-4 font-normal",
        // Non-primary action beside an `outline` primary (#746); underlines on hover and focus, with a ring since it has no border.
        text: "min-h-6 rounded-md text-foreground hover:underline focus-visible:underline focus-visible:ring-2 underline-offset-2 aria-disabled:hover:no-underline",
        // Same shape as `text`, red label, for actions that open a confirm dialog.
        "text-destructive":
          "min-h-6 rounded-md text-destructive hover:underline focus-visible:underline focus-visible:ring-2 underline-offset-2 aria-disabled:hover:no-underline",
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
