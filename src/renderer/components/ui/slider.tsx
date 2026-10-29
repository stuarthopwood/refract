import type { CSSProperties, InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// A native range input (arrow keys, Home/End and PageUp/PageDown for free) with a visible 16px
// thumb: a foreground fill with a background-coloured border, so it holds 3:1 against the track
// in every theme. `trackBackground` replaces the plain track fill (for example a hue gradient).
export function Slider({
  trackBackground,
  className,
  style,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { trackBackground?: string }) {
  const trackStyle = { '--slider-track': trackBackground ?? 'var(--border)', ...style } as CSSProperties
  return (
    <input
      {...props}
      type="range"
      style={trackStyle}
      className={cn(
        'h-4 min-w-0 cursor-pointer appearance-none bg-transparent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:appearance-auto',
        '[&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-(--slider-track) [&::-webkit-slider-runnable-track]:border [&::-webkit-slider-runnable-track]:border-border',
        '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:ring-1 [&::-webkit-slider-thumb]:ring-foreground',
        '[&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-(--slider-track) [&::-moz-range-track]:border [&::-moz-range-track]:border-border',
        '[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-foreground',
        className
      )}
    />
  )
}
