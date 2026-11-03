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
  /** Replaces the `<input>` with this element, which takes the field's styling and props. */
  input?: React.ReactElement
}

/** An Input with room on the right for one `InputActionButton` (clear, reveal): one padding for every such field. */
export function InputWithAction({ wrapperClassName, className, children, input, ...props }: InputWithActionProps) {
  return (
    <div className={cn('relative min-w-0', wrapperClassName)}>
      <Input {...props} asChild={input !== undefined} className={cn('pr-8', className)}>
        {input}
      </Input>
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
      // Radix tooltip triggers add a description that contradicts the toggle's constant name.
      aria-describedby={undefined}
      className={cn(
        'absolute inset-y-0 right-1 my-auto text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground focus-visible:ring-0',
        INSET_FOCUS_OUTLINE_CLASS,
        className
      )}
    />
  )
}
