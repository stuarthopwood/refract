import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const alertVariants = cva(
  "group/alert relative grid w-full gap-1 rounded-lg border px-2 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
        warning: "bg-card text-card-foreground *:[svg]:text-severity-warning forced-colors:*:[svg]:text-[CanvasText]",
      },
      box: {
        default: "",
        // Gate round 2 (code-reviewer/architect M1): for Alerts already nested inside a Card
        // (e.g. decision-card submit errors), the outer Card is the box -- this strips the
        // Alert's own border/fill/padding/radius so it doesn't double-box, while keeping the
        // icon-grid layout and `role="alert"` semantics untouched.
        inline: "border-0 bg-transparent px-0 py-0 rounded-none",
      },
    },
    defaultVariants: {
      variant: "default",
      box: "default",
    },
  }
)

function Alert({
  className,
  variant,
  box,
  role = "alert",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role={role}
      className={cn(alertVariants({ variant, box }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

// In-flow actions row under the description (use instead of the corner-pinned `AlertAction` when
// the text must not run under the buttons).
function AlertActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-actions"
      className={cn("mt-1 flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction, AlertActions }
