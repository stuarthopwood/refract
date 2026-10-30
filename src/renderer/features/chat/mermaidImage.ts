const SCALE = 2
// Keeps a pathological viewBox from allocating a huge canvas.
const MAX_PIXELS = 16_000_000

function svgSize(svg: string): { width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const bw = box?.[2] ?? 0
  const bh = box?.[3] ?? 0
  if (box?.length === 4 && bw > 0 && bh > 0) return { width: bw, height: bh }
  const width = parseFloat(root.getAttribute('width') ?? '')
  const height = parseFloat(root.getAttribute('height') ?? '')
  if (width > 0 && height > 0) return { width, height }
  throw new Error('The diagram has no size')
}

/** Rasterises Mermaid SVG to a PNG at 2x on `background`; resolves to base64 without the data-URL prefix. */
export async function svgToPngBase64(svg: string, background: string): Promise<string> {
  const { width, height } = svgSize(svg)
  const w = Math.ceil(width * SCALE)
  const h = Math.ceil(height * SCALE)
  if (w * h > MAX_PIXELS) throw new Error('The diagram is too large to export as an image')
  const img = new Image()
  img.width = w
  img.height = h
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('The diagram could not be drawn'))
  })
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await loaded
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The diagram could not be drawn')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}
