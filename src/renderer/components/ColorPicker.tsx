import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { parseHex, rgbToHex } from '@/lib/projectColor'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// A small, keyboard-operable colour picker: an optional preset swatch group and three native range sliders (hue, saturation,
// lightness), so arrow keys, Home/End and PageUp/PageDown all work with no custom key handling,
// and each slider announces its own value. Reusable by any screen that needs a free colour.

function hexToHsl(hex: string): [number, number, number] {
  const rgb = parseHex(hex) ?? [0.5, 0.5, 0.5]
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
  return [Math.round(h) % 360, Math.round(s * 100), Math.round(l * 100)]
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100
  const light = l / 100
  const a = sat * Math.min(light, 1 - light)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return rgbToHex([f(0), f(8), f(4)])
}

export interface ColorPickerPreset {
  id: string
  name: string
  /** Any CSS colour, for example `var(--project-1)`. */
  color: string
}

function SliderRow({
  label,
  value,
  max,
  unit,
  trackBackground,
  onChange
}: {
  label: string
  value: number
  max: number
  unit: string
  trackBackground?: string
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <span id={id} className="w-16 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <Slider
        min={0}
        max={max}
        step={1}
        value={value}
        aria-labelledby={id}
        aria-valuetext={`${value}${unit}`}
        trackBackground={trackBackground}
        onValueChange={onChange}
        className="flex-1"
      />
    </div>
  )
}

export function ColorPicker({
  value,
  onChange,
  presets,
  presetValue,
  onPresetChange,
  presetsAction,
  presetsLabel = 'Preset colours'
}: {
  value: string
  onChange: (hex: string) => void
  presets?: readonly ColorPickerPreset[]
  /** The selected preset's id, or `null`/`undefined` when none is. */
  presetValue?: string | null
  onPresetChange?: (id: string) => void
  /** Rendered directly under the swatches (for example a reset button). */
  presetsAction?: ReactNode
  presetsLabel?: string
}) {
  // The sliders own their [h, s, l]: hex round-trips lose hue at S=0 and L=0/100 and quantise
  // each step. The tuple is only re-derived from `value` when it no longer matches what the
  // tuple produces (an outside change such as a typed hex).
  const [held, setHeld] = useState<[number, number, number]>(() => hexToHsl(value))
  const normalised = rgbToHex(parseHex(value) ?? [0.5, 0.5, 0.5])
  const [h, s, l] = hslToHex(...held) === normalised ? held : hexToHsl(value)
  const set = (nh: number, ns: number, nl: number) => {
    setHeld([nh, ns, nl])
    onChange(hslToHex(nh, ns, nl))
  }
  return (
    <div className="flex flex-col gap-2">
      {presets && onPresetChange && (
        <RadioGroup aria-label={presetsLabel} value={presetValue ?? ''} onValueChange={onPresetChange} className="grid grid-cols-5 gap-2">
          {presets.map((preset) => (
            <Tooltip key={preset.id}>
              <TooltipTrigger asChild>
                <RadioGroupItem
                  value={preset.id}
                  aria-label={preset.name}
                  style={{ backgroundColor: preset.color, forcedColorAdjust: 'none' }}
                  className={cn(
                    'size-8 w-8 items-center justify-center rounded-md border-2 border-border px-0 py-0 hover:opacity-90',
                    'data-[state=checked]:border-foreground data-[state=checked]:ring-2 data-[state=checked]:ring-foreground'
                  )}
                />
              </TooltipTrigger>
              <TooltipContent>{preset.name}</TooltipContent>
            </Tooltip>
          ))}
        </RadioGroup>
      )}
      {presetsAction && <div className="flex">{presetsAction}</div>}
      <SliderRow
        label="Hue"
        value={h}
        max={359}
        unit=" degrees"
        trackBackground="linear-gradient(to right, hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))"
        onChange={(nh) => set(nh, s, l)}
      />
      <SliderRow label="Saturation" value={s} max={100} unit=" percent" onChange={(ns) => set(h, ns, l)} />
      <SliderRow label="Lightness" value={l} max={100} unit=" percent" onChange={(nl) => set(h, s, nl)} />
    </div>
  )
}