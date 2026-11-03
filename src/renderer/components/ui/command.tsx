import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { SearchField } from "@/components/SearchField"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

type CommandDialogProps = React.ComponentProps<typeof Dialog> & {
  title: string
  description: string
  onCloseAutoFocus?: (event: Event) => void
  children: React.ReactNode
}

function CommandDialog({
  title,
  description,
  onCloseAutoFocus,
  children,
  ...props
}: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** The palette's search box: the shared `SearchField`, inset from the surface edge so its focus ring is never clipped by the dialog. */
function CommandInput({
  value,
  onValueChange,
  label,
  placeholder,
  onEscape,
}: {
  value: string
  onValueChange(value: string): void
  label: string
  placeholder: string
  onEscape(): void
}) {
  return (
    <div data-slot="command-input-wrapper" className="p-2">
      <SearchField
        value={value}
        onValueChange={onValueChange}
        label={label}
        placeholder={placeholder}
        clearLabel="Clear search"
        tooltipSide="bottom"
        onEscape={onEscape}
        // cmdk's own input keeps its search state and active-row wiring; it reads changes through `onValueChange`.
        input={<CommandPrimitive.Input data-slot="command-input" onValueChange={onValueChange} />}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-80 overflow-y-auto overflow-x-hidden p-1", className)}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/** Result count for assistive tech (persistent live region) plus the visible empty state; kept outside the listbox. */
function CommandStatus({ count }: { count: number }) {
  return (
    <>
      <div data-slot="command-status" role="status" aria-live="polite" className="sr-only">
        {count === 0 ? "No results" : `${count} ${count === 1 ? "result" : "results"}`}
      </div>
      {count === 0 && (
        <div aria-hidden className="py-6 text-center text-sm text-muted-foreground">
          No results.
        </div>
      )}
    </>
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandItem({
  className,
  icon,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & {
  /** Leading icon in a fixed 16px column, so labels line up across rows. */
  icon?: React.ReactNode
}) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex min-w-0 cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:ring-2 data-[selected=true]:ring-inset data-[selected=true]:ring-ring forced-colors:data-[selected=true]:bg-[Highlight] forced-colors:data-[selected=true]:text-[HighlightText]",
        className
      )}
      {...props}
    >
      {icon !== undefined && (
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
          {icon}
        </span>
      )}
      {children}
    </CommandPrimitive.Item>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto shrink-0 font-code text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandStatus,
  CommandGroup,
  CommandItem,
  CommandShortcut,
}
