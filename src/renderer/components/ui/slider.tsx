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
  /** Replaces the track fill (for example a hue gradient) and hides the split active/inactive track. */
  trackBackground?: string
}

// The thumb is a 24px-wide hit target; Radix keeps its centre this far from each end of the track.
const THUMB_HIT_PX = 24
// Half the 4px bar plus the 6px gap the Material Design 3 split track leaves each side of the handle.
const HANDLE_CLEARANCE_PX = 8
/** Dots mark steps only when `step` gives this few stops or fewer. */
const MAX_STOP_DOTS = 10

/** Where the handle sits along the travel, 0 to 1. */
export function sliderFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

/** The CSS length of the handle centre: Radix insets the thumb by half its width at both ends. */
const handleCentre = (fraction: number): string => `calc(${THUMB_HIT_PX / 2}px + (100% - ${THUMB_HIT_PX}px) * ${fraction})`

/** Step positions (0 to 1) to draw as dots, or none when the range holds more than a small set of stops. */
export function sliderStopFractions(min: number, max: number, step: number): number[] {
  const count = step > 0 ? Math.round((max - min) / step) : 0
  if (count < 2 || count > MAX_STOP_DOTS) return []
  return Array.from({ length: count + 1 }, (_, i) => i / count)
}

/** Radix reports an array; this control is single-thumb, so only its first value is passed on. */
export function forwardFirstValue(onValueChange: (value: number) => void): (next: number[]) => void {
  return (next) => {
    const first = next[0]
    if (first !== undefined) onValueChange(first)
  }
}

// Material Design 3 (#1852): a 16px track split by a 6px gap each side of a 4x44px vertical bar handle.
// The thumb itself is the 24x44px hit target; the bar is its pseudo-element, so focus, drag and the
// arrow/Page/Home/End keys stay on Radix. No transition: the control must not animate for users who
// reduce motion.
function Slider({
  className,
  value,
  onValueChange,
  trackBackground,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
  "aria-valuetext": ariaValuetext,
  min = 0,
  max = 100,
  step = 1,
  ...props
}: SliderProps) {
  const fraction = sliderFraction(value, min, max)
  const centre = handleCentre(fraction)
  const stops = trackBackground ? [] : sliderStopFractions(min, max, step)
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={forwardFirstValue(onValueChange)}
      className={cn("group/slider relative flex h-11 w-full min-w-24 touch-none items-center select-none data-[disabled]:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        style={trackBackground ? { background: trackBackground } : undefined}
        className="relative h-4 grow rounded-full forced-colors:bg-[GrayText]"
      >
        {!trackBackground && (
          <>
            <span
              data-slot="slider-range"
              style={{ width: `max(0px, calc(${centre} - ${HANDLE_CLEARANCE_PX}px))` }}
              className="absolute inset-y-0 left-0 rounded-l-full rounded-r-sm bg-primary forced-colors:bg-[Highlight]"
            />
            <span
              data-slot="slider-remainder"
              style={{ left: `calc(${centre} + ${HANDLE_CLEARANCE_PX}px)` }}
              className="absolute inset-y-0 right-0 rounded-l-sm rounded-r-full bg-muted forced-colors:bg-[GrayText]"
            />
            {stops.map((stop) => (
              <span
                key={stop}
                data-slot="slider-stop"
                aria-hidden
                style={{ left: handleCentre(stop) }}
                className={cn(
                  "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                  stop <= fraction ? "bg-primary-foreground" : "bg-foreground"
                )}
              />
            ))}
          </>
        )}
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        aria-valuetext={ariaValuetext}
        className={cn(
          "relative block h-11 w-6 outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary after:content-['']",
          "group-active/slider:after:w-0.5 focus-visible:after:ring-3 focus-visible:after:ring-focus-glow",
          trackBackground && "after:shadow-[0_0_0_2px_var(--background)]",
          "forced-colors:after:bg-[Highlight] forced-colors:focus-visible:after:outline-2 forced-colors:focus-visible:after:outline-[Highlight]"
        )}
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
