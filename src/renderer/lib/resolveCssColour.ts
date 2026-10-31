/**
 * Runs `fn` with a reader that resolves `--<prefix><name>` to opaque `#rrggbb` as the app currently renders it,
 * so oklch, rgba and color-mix token values reach libraries that only accept hex. See-through values are
 * composited over `--<prefix>bg`.
 */
export function withResolvedTokens<T>(prefix: string, fn: (read: (name: string) => string) => T): T {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:-9999px;visibility:hidden'
  document.body.appendChild(probe)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let computed = ''
  const rgba = (name: string): [number, number, number, number] | null => {
    probe.style.color = `var(--${prefix}${name})`
    computed = getComputedStyle(probe).color
    if (!ctx) return null
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = 'transparent'
    ctx.fillStyle = computed
    ctx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data
    return [r, g, b, a]
  }
  const hex = (c: number[]) => `#${c.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`
  const read = (name: string): string => {
    const c = rgba(name)
    const own = computed
    if (!c) return own
    if (c[3] === 255) return hex(c)
    const bg = rgba('bg')
    // A fully transparent token resolves to the backdrop, never the raw `rgba(0, 0, 0, 0)` string libraries reject.
    if (!bg || bg[3] !== 255) return c[3] === 0 ? own : hex(c)
    const k = c[3] / 255
    return hex(c.slice(0, 3).map((v, i) => v * k + (bg[i] ?? 0) * (1 - k)))
  }
  try {
    return fn(read)
  } finally {
    probe.remove()
  }
}
