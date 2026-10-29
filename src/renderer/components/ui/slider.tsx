import * as React from "react"
import { cn } from "@/lib/utils"
import { Slider as SliderPrimitive } from "radix-ui"

interface SliderProps
  extends Omit<React.ComponentProps<typeof SliderPrimitive.Root>, "value" | "defaultValue" | "onValueChange" | "aria-label" | "aria-labelledby"> {
  value: number
  onValueChange: (value: number) => void
  /** Names the thumb (the element with `role="slider"`). */
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-describedby"?: string
  /** Spoken value, e.g. "110 percent, about 15 px"; defaults to the number. */
  "aria-valuetext"?: string
  /** Replaces the track fill (for example a hue gradient) and hides the range fill. */
  trackBackground?: string
}

// Spec 036 (#842): a single-thumb slider on Radix (arrow, Page, Home and End keys come with it). The
// accessible name, description and value text go on the thumb, because that is the `role="slider"`
// node. No transition: the control must not animate for users who reduce motion.
function Slider({
  className,
  value,
  onValueChange,
  trackBackground,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
  "aria-valuetext": ariaValuetext,
  ...props
}: SliderProps) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={[value]}
      onValueChange={(next) => {
        const first = next[0]
        if (first !== undefined) onValueChange(first)
      }}
      className={cn("relative flex h-5 w-full min-w-24 touch-none items-center select-none data-[disabled]:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        style={trackBackground ? { background: trackBackground } : undefined}
        className="relative h-1 grow overflow-hidden rounded-full bg-muted forced-colors:bg-[GrayText]"
      >
        {!trackBackground && (
          <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-foreground forced-colors:bg-[Highlight]" />
        )}
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        aria-valuetext={ariaValuetext}
        className="block size-4 rounded-full border border-foreground bg-background outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 forced-colors:border-[CanvasText] forced-colors:bg-[Canvas]"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
