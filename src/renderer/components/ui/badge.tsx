import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0 text-xs font-normal whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-focus-glow aria-invalid:border-destructive aria-invalid:ring-invalid-ring [&>svg]:pointer-events-none [&>svg]:size-4!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary-hover-bg",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary-hover-bg",
        destructive:
          "bg-destructive-tint-bg text-destructive focus-visible:ring-invalid-ring dark:bg-destructive-tint-strong-bg dark:focus-visible:ring-invalid-ring [a]:hover:bg-destructive-tint-strong-bg",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-row-hover-bg",
        link: "text-primary underline-offset-4 hover:underline",
        // Borderless text-only chip for a non-button-looking control (#1873); focus shows an inset outline, never a border.
        plain:
          "border-transparent text-accent-text focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
        focused:
          "h-auto border-active-indicator bg-focused-badge-bg py-1 font-medium text-active-indicator-foreground",
        warning: "h-auto border-severity-warning bg-severity-warning-bg py-1 text-severity-warning",
        role: "text-background"
      },
      tone: {
        default: "bg-role-default",
        smol: "bg-role-smol",
        slow: "bg-role-slow",
        plan: "bg-role-plan"
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  tone,
  asChild = false,
  onDismiss,
  dismissLabel,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
    /** Adds a trailing icon-only dismiss button; `dismissLabel` is its tooltip and accessible name. */
    onDismiss?: () => void
    dismissLabel?: string
  }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, tone: variant === "role" ? (tone ?? "default") : undefined }), onDismiss && "max-w-full overflow-visible", className)}
      {...props}
    >
      {onDismiss && !asChild ? (
        <>
          <span className="min-w-0 truncate">{children}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="-my-1 -mr-1 size-6 shrink-0 rounded-sm"
                aria-label={dismissLabel ?? "Remove"}
                onClick={onDismiss}
              >
                <XIcon aria-hidden className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{dismissLabel ?? "Remove"}</TooltipContent>
          </Tooltip>
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Badge, badgeVariants }
