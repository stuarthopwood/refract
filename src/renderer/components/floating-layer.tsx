import * as React from 'react'
import { cn } from '@/lib/utils'

export interface FloatingLayerProps extends React.ComponentProps<'div'> {
  /** Shown when true; when false the layer fades out but stays reachable by keyboard focus
   * (focus-within reveals it), so hidden controls are never unreachable. */
  visible?: boolean
  /** No box of its own (border, surface, shadow, padding): children carry their own surface, and the layer itself never intercepts the pointer. */
  bare?: boolean
}

/** A small floating layer on the elevated surface with the shared floating-layer shadow, faded
 * in and out over 120 ms (instant under reduced motion). Position it with `className`; put any
 * controls in it as children. Hover and focus-within keep it shown; a hidden layer keeps receiving the pointer so hovering it brings it back. */
export function FloatingLayer({ visible = true, bare = false, className, ...props }: FloatingLayerProps) {
  return (
    <div
      data-slot="floating-layer"
      data-visible={visible ? 'true' : 'false'}
      className={cn(
        'absolute z-10 flex flex-col gap-1 transition-opacity duration-[120ms] motion-reduce:transition-none',
        'hover:opacity-100 focus-within:opacity-100',
        bare ? 'pointer-events-none *:pointer-events-auto' : 'rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
        visible ? 'opacity-100' : 'opacity-0',
        className
      )}
      {...props}
    />
  )
}
