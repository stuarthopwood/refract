import { STUB_PX, type MapMark } from './scrollbarMapMath'

export interface MapColors {
  user: string
  agent: string
  track: string
  window: string
}

const TOKENS: Record<keyof MapColors, string> = {
  user: '--scrollbar-map-user',
  agent: '--scrollbar-map-agent',
  track: '--scrollbar-map-track',
  window: '--scrollbar-map-window'
}

/** Resolves the map's colour tokens to concrete colours a canvas can use. A canvas cannot read
 * `var()`, so each token is set as the probe element's `color` and read back computed. */
export function resolveMapColors(probe: HTMLElement): MapColors {
  const colors = {} as MapColors
  for (const key of Object.keys(TOKENS) as (keyof MapColors)[]) {
    probe.style.color = `var(${TOKENS[key]})`
    colors[key] = getComputedStyle(probe).color
  }
  probe.style.color = ''
  return colors
}

export interface PaintInput {
  canvas: HTMLCanvasElement
  cssWidth: number
  cssHeight: number
  dpr: number
  colors: MapColors
  marks: readonly MapMark[]
  window: { y: number; h: number }
  /** Draw the "N earlier turns" stub (three dashes across both halves) at the top. */
  stub: boolean
}

/** Draws the whole strip. Only the merged marks are drawn, so the cost follows the strip height,
 * not the message count. User marks fill the left half, agent marks the right half. */
export function paintMap({ canvas, cssWidth, cssHeight, dpr, colors, marks, window: win, stub }: PaintInput): void {
  const pixelWidth = Math.max(1, Math.round(cssWidth * dpr))
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = colors.track
  ctx.fillRect(0, 0, cssWidth, cssHeight)
  // High Contrast: a filled window would hide the marks (one system colour per role), so outline it.
  const outlineWindow = window.matchMedia('(forced-colors: active)').matches
  if (!outlineWindow) {
    ctx.fillStyle = colors.window
    ctx.fillRect(0, win.y, cssWidth, win.h)
  }
  const half = cssWidth / 2
  for (const mark of marks) {
    ctx.fillStyle = mark.kind === 'user' ? colors.user : colors.agent
    ctx.fillRect(mark.kind === 'user' ? 1 : half, mark.y, half - 1, mark.h)
  }
  if (outlineWindow) {
    ctx.strokeStyle = colors.window
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, win.y + 0.5, cssWidth - 1, Math.max(1, win.h - 1))
  }
  if (stub) {
    ctx.fillStyle = colors.agent
    const dash = (STUB_PX - 2) / 3
    for (let i = 0; i < 3; i += 1) ctx.fillRect(1, 1 + i * (dash + 1), cssWidth - 2, Math.max(1, dash - 1))
  }
}
