import * as React from "react"
import { ChevronDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/** A primary action joined to a chevron that opens a menu of related actions (#1140). The menu's
 * items are the caller's own `DropdownMenu*` children. Radix opens the menu on Enter, Space and
 * ArrowDown (so Alt+Down too) and returns focus to the chevron on Esc; the Menu key is added here.
 * Without `menu` children it renders the plain button alone. */
function SplitButton({
  children,
  menu,
  menuLabel,
  onClick,
  disabled,
  size = "sm",
  variant = "default",
  className,
}: {
  children: React.ReactNode
  menu?: React.ReactNode
  /** Accessible name of the chevron, for example "More approve options". */
  menuLabel: string
  onClick: () => void
  disabled?: boolean
  size?: "sm" | "default"
  variant?: "default" | "outline" | "secondary"
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  if (!menu) {
    return (
      <Button size={size} variant={variant} disabled={disabled} onClick={onClick} className={className}>
        {children}
      </Button>
    )
  }
  return (
    <div data-slot="split-button" className={cn("inline-flex items-stretch", className)}>
      <Button size={size} variant={variant} disabled={disabled} onClick={onClick} className="rounded-r-none">
        {children}
      </Button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size={size === "sm" ? "icon-sm" : "icon"}
            variant={variant}
            disabled={disabled}
            aria-label={menuLabel}
            className="rounded-l-none border-l border-l-primary-foreground/30"
            onKeyDown={(event) => {
              if (event.key === "ContextMenu") {
                event.preventDefault()
                setOpen(true)
              }
            }}
          >
            <ChevronDownIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">{menu}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export { SplitButton }
