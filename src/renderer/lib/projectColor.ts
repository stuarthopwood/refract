import type { ProjectColor } from '../../shared/model'

// Issue #887: the Project colour. Presets are theme tokens (`--project-1` to `--project-10`,
// each measured at 4.5:1 against `--sidebar` by `check:theme-contrast`). A custom hex is user
// data: it is nudged in lightness, keeping hue and chroma, until it reaches 4.5:1 against the
// Session list's real background, so an unreadable pick cannot make a header illegible.

export const PROJECT_PRESETS = [
  { id: 'lime', name: 'Lime' },
  { id: 'teal', name: 'Teal' },
  { id: 'cyan', name: 'Cyan' },
  { id: 'blue', name: 'Blue' },
  { id: 'indigo', name: 'Indigo' },
  { id: 'violet', name: 'Violet' },
  { id: 'magenta', name: 'Magenta' },
  { id: 'pink', name: 'Pink' },
  { id: 'slate', name: 'Slate' },
  { id: 'sand', name: 'Sand' }
] as const

export const MIN_PROJECT_CONTRAST = 4.5

type Rgb = [number, number, number] // 0..1, gamma-encoded sRGB

export function presetToken(id: string): string | null {
  const index = PROJECT_PRESETS.findIndex((preset) => preset.id === id)
  return index < 0 ? null : `--project-${index + 1}`
}

/** `#RGB` or `#RRGGBB`, nothing else -- the same rule the Rust handler enforces. */
export function parseHex(hex: string): Rgb | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match) return null
  const digits = match[1]!
  const full = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

function rgbToOklch(rgb: Rgb): { l: number; c: number; h: number } {
  const [r, g, b] = rgb.map(toLinear) as Rgb
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
}

function oklchToRgb(L: number, C: number, H: number): Rgb {
  const A = C * Math.cos((H * Math.PI) / 180)
  const B = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
  return lin.map((v) => toGamma(Math.min(1, Math.max(0, v)))) as Rgb
}

// The state colours a Project colour should not be mistaken for: stopped red, needs-you amber,
// working green (hues from globals.css; see the issue's grilled decision on the presets).
const STATE_HUES: Array<{ hue: number; name: string }> = [
  { hue: 22, name: 'Stopped' },
  { hue: 70, name: 'Needs you' },
  { hue: 162, name: 'Working' }
]

/** The name of the Session state colour a custom hex sits close to, or `null`. */
export function nearStateColor(hex: string): string | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const { c, h } = rgbToOklch(rgb)
  if (c < 0.07) return null
  const hit = STATE_HUES.find(({ hue }) => Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue)) <= 14)
  return hit ? hit.name : null
}

/** Keeps hue and chroma, moves lightness away from the background until `min` is met. */
export function adjustForContrast(hex: string, background: Rgb, min = MIN_PROJECT_CONTRAST): { hex: string; adjusted: boolean } {
  const rgb = parseHex(hex)
  if (!rgb) return { hex, adjusted: false }
  if (contrastRatio(rgb, background) >= min) return { hex: rgbToHex(rgb), adjusted: false }
  const { l, c, h } = rgbToOklch(rgb)
  const lighten = luminance(background) < 0.5
  let [lo, hi] = lighten ? [l, 1] : [0, l]
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const ok = contrastRatio(oklchToRgb(mid, c, h), background) >= min
    if (lighten === ok) hi = mid
    else lo = mid
  }
  // Take the end of the interval that is guaranteed to pass.
  const candidate = oklchToRgb(lighten ? hi : lo, c, h)
  return { hex: rgbToHex(candidate), adjusted: true }
}

/** The Session list's actual background, read from the live `--sidebar` token so it follows
 * the active theme. `null` outside a browser (no layout, no canvas). */
export function readSidebarRgb(): Rgb | null {
  if (typeof document === 'undefined') return null
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--sidebar)'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = '#000'
  ctx.fillStyle = computed
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return [(r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255]
}

/** The CSS colour a Project header draws with, or `undefined` for no colour. Presets resolve
 * through their theme token; a custom hex is contrast-adjusted against `background` when known. */
export function projectColorCss(color: ProjectColor | undefined, background: Rgb | null): { css: string; adjusted: boolean } | undefined {
  if (!color) return undefined
  if (color.kind === 'preset') {
    const token = presetToken(color.id)
    return token ? { css: `var(${token})`, adjusted: false } : undefined
  }
  if (!parseHex(color.hex)) return undefined
  if (!background) return { css: color.hex, adjusted: false }
  const result = adjustForContrast(color.hex, background)
  return { css: result.hex, adjusted: result.adjusted }
}
