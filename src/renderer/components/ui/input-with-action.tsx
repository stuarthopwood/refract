import * as React from 'react'
import { Button } from '@/components/ui/button'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type InputWithActionProps = React.ComponentProps<typeof Input> & {
  /** Applied to the wrapper; `className` styles the `<input>`. */
  wrapperClassName?: string
  /** Overlays inside the wrapper: leading icons and one `InputActionButton`. */
  children?: React.ReactNode
}

/** An Input with room on the right for one `InputActionButton` (clear, reveal): one padding for every such field. */
export function InputWithAction({ wrapperClassName, className, children, ...props }: InputWithActionProps) {
  return (
    <div className={cn('relative min-w-0', wrapperClassName)}>
      <Input {...props} className={cn('pr-8', className)} />
      {children}
    </div>
  )
}

/** The trailing 24px button of an `InputWithAction`, pinned inside the field's right edge. */
export function InputActionButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      {...props}
      className={cn(
        'absolute right-1 top-1 text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground focus-visible:ring-0',
        INSET_FOCUS_OUTLINE_CLASS,
        className
      )}
    />
  )
}
