/**
 * Runs `fn` with a reader that resolves `--<prefix><name>` to `#rrggbb` as the app currently renders it,
 * so oklch, rgba and color-mix token values all reach libraries that only accept hex.
 */
export function withResolvedTokens<T>(prefix: string, fn: (read: (name: string) => string) => T): T {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:-9999px;visibility:hidden'
  document.body.appendChild(probe)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const read = (name: string): string => {
    probe.style.color = `var(--${prefix}${name})`
    const computed = getComputedStyle(probe).color
    if (!ctx) return computed
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = computed
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  }
  try {
    return fn(read)
  } finally {
    probe.remove()
  }
}
