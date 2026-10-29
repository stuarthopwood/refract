import * as React from 'react'
import { cn } from '@/lib/utils'

export interface FloatingLayerProps extends React.ComponentProps<'div'> {
  /** Shown when true; when false the layer fades out but stays reachable by keyboard focus
   * (focus-within reveals it), so hidden controls are never unreachable. */
  visible?: boolean
}

/** A small floating layer on the elevated surface with the shared floating-layer shadow, faded
 * in and out over 120 ms (instant under reduced motion). Position it with `className`; put any
 * controls in it as children. Hover and focus-within keep it shown. */
export function FloatingLayer({ visible = true, className, ...props }: FloatingLayerProps) {
  return (
    <div
      data-slot="floating-layer"
      data-visible={visible ? 'true' : 'false'}
      className={cn(
        'absolute z-10 flex flex-col gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md transition-opacity duration-[120ms] motion-reduce:transition-none',
        'hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
        className
      )}
      {...props}
    />
  )
}
