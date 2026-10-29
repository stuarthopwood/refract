import { useId } from 'react'
import { cn } from '@/lib/utils'
import { parseHex, rgbToHex } from '@/lib/projectColor'

// A small, keyboard-operable colour picker: three native range sliders (hue, saturation,
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

function Slider({
  label,
  value,
  max,
  unit,
  trackStyle,
  onChange
}: {
  label: string
  value: number
  max: number
  unit: string
  trackStyle?: string
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-16 shrink-0 text-xs text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        aria-valuetext={`${value}${unit}`}
        onChange={(event) => onChange(Number(event.target.value))}
        style={trackStyle ? { background: trackStyle } : undefined}
        className={cn(
          'h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:appearance-auto'
        )}
      />
    </div>
  )
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [h, s, l] = hexToHsl(value)
  const set = (nh: number, ns: number, nl: number) => onChange(hslToHex(nh, ns, nl))
  return (
    <div className="flex flex-col gap-2">
      <Slider
        label="Hue"
        value={h}
        max={359}
        unit=" degrees"
        trackStyle="linear-gradient(to right, hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))"
        onChange={(nh) => set(nh, s, l)}
      />
      <Slider label="Saturation" value={s} max={100} unit=" percent" onChange={(ns) => set(h, ns, l)} />
      <Slider label="Lightness" value={l} max={100} unit=" percent" onChange={(nl) => set(h, s, nl)} />
    </div>
  )
}
