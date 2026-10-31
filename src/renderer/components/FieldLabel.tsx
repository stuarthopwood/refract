import * as React from 'react'
import { cn } from '@/lib/utils'

type FieldLabelProps = React.ComponentProps<'label'> & { htmlFor: string }

/** The label above a form field: `text-sm`, like every dialog label, tied to its control by `htmlFor`. */
export function FieldLabel({ className, ...props }: FieldLabelProps) {
  return <label className={cn('text-sm', className)} {...props} />
}
