// Real-rendered-DOM contrast measurement, loaded as an ES module in the renderer by
// scripts/check-mermaid-contrast.mjs's Electron harness (never from Node).
// Text contrast is measured from real pixels (computed style misses stroked lines behind labels):
// each diagram renders with glyphs visible and hidden (`opacity: 0`). `capturePage()` exists only in
// the Electron main process, so the caller takes the screenshots and does the ratio math.
// Shape-vs-background and pie-slice checks still use computed style + `elementsFromPoint`.

function srgbToLinear(c) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(c) {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b)
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

let namedColourProbe = null

function parseColor(raw) {
  if (!raw) return null
  const str = raw.trim()
  if (str === 'none' || str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const rgbMatch = str.match(/^rgba?\(([^)]+)\)$/i)
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((s) => parseFloat(s))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  if (str.startsWith('#')) {
    let hex = str.slice(1)
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
    const n = parseInt(hex, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  // Named colours, `hsl()` etc.: let the browser resolve them via a throwaway element.
  if (!namedColourProbe) namedColourProbe = document.createElement('div')
  if (!namedColourProbe.isConnected) document.body.appendChild(namedColourProbe)
  namedColourProbe.style.color = ''
  namedColourProbe.style.color = str
  const resolved = getComputedStyle(namedColourProbe).color
  if (resolved && resolved !== str) return parseColor(resolved)
  return null
}

function over(top, bottom) {
  const a = top.a + bottom.a * (1 - top.a)
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
    g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
    b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
    a
  }
}

function accumulatedBrightness(el) {
  let factor = 1
  let node = el
  while (node && node.nodeType === 1) {
    const f = getComputedStyle(node).filter
    if (f && f !== 'none') {
      const m = f.match(/brightness\(([\d.]+)(%?)\)/)
      if (m) factor *= m[2] === '%' ? parseFloat(m[1]) / 100 : parseFloat(m[1])
    }
    node = node.parentElement
  }
  return factor
}

function applyBrightness(c, factor) {
  if (factor === 1) return c
  return { r: Math.min(255, c.r * factor), g: Math.min(255, c.g * factor), b: Math.min(255, c.b * factor), a: c.a }
}

function effectiveAlpha(el, colorAlpha) {
  const cs = getComputedStyle(el)
  const opacity = parseFloat(cs.opacity)
  const fillOpacity = cs.fillOpacity !== '' ? parseFloat(cs.fillOpacity) : Number.NaN
  return colorAlpha * (Number.isNaN(opacity) ? 1 : opacity) * (Number.isNaN(fillOpacity) ? 1 : fillOpacity)
}

const SHAPE_TAGS = new Set(['rect', 'path', 'circle', 'ellipse', 'polygon', 'polyline', 'line'])
// Shape tags that can paint a FILL background layer. Excludes 'line': it is stroke-only, and its
// default opaque-black `fill` would inject a phantom dark layer under anything drawn on it.
const BACKGROUND_FILL_TAGS = new Set(['rect', 'path', 'circle', 'ellipse', 'polygon', 'polyline'])

// Resolves the composited background beneath `el` at viewport point (x, y): alpha-composites
// every painted layer from `elementsFromPoint` (skipping `el` and its ancestors) bottom-up,
// applying accumulated `brightness()` filters. The wrapper has an opaque `--card` background, so
// this always bottoms out at a known base. Used for shape and pie checks, not text.
function resolveBackground(el, x, y) {
  const stack = document.elementsFromPoint(x, y)
  const layers = []
  for (const node of stack) {
    if (node === el) continue
    const tag = node.tagName.toLowerCase()
    if (BACKGROUND_FILL_TAGS.has(tag)) {
      const fill = parseColor(getComputedStyle(node).fill)
      if (fill && fill.a > 0) {
        layers.push(applyBrightness({ ...fill, a: effectiveAlpha(node, fill.a) }, accumulatedBrightness(node)))
      }
    } else if (node instanceof HTMLElement) {
      const bg = parseColor(getComputedStyle(node).backgroundColor)
      if (bg && bg.a > 0) {
        layers.push(applyBrightness({ ...bg, a: effectiveAlpha(node, bg.a) }, accumulatedBrightness(node)))
      }
    }
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 } // unreachable in practice -- the wrapper is always opaque
  for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc)
  return acc
}

function isLargeText(el) {
  const cs = getComputedStyle(el)
  const px = parseFloat(cs.fontSize)
  const weight = parseInt(cs.fontWeight, 10) || 400
  return weight >= 700 ? px >= 18.66 : px >= 24
}

function classesOf(el) {
  if (!el) return ''
  if (typeof el.className === 'string') return el.className
  if (el.className && el.className.baseVal !== undefined) return el.className.baseVal
  return el.getAttribute('class') || ''
}

// Every leaf text node Mermaid renders: SVG `<text>`/`<tspan>` (multi-line labels use several
// positioned `<tspan>`s) and foreignObject HTML leaves (Journey's `<div class="label">`).
function collectTextLeaves(root) {
  const leaves = []
  root.querySelectorAll('text').forEach((t) => {
    const tspans = Array.from(t.children).filter((c) => c.tagName.toLowerCase() === 'tspan')
    if (tspans.length > 0) {
      tspans.forEach((ts) => {
        if (ts.textContent.trim()) leaves.push(ts)
      })
    } else if (t.textContent.trim()) {
      leaves.push(t)
    }
  })
  root.querySelectorAll('foreignObject *').forEach((el) => {
    if (el.children.length === 0 && el.textContent.trim()) leaves.push(el)
  })
  return leaves
}

// Graphical-object (non-text, WCAG 1.4.11, >=3:1) selectors per diagram type. They only choose
// which elements to inspect; colours always come from `getComputedStyle`.
const SHAPE_SELECTORS = {
  // Pie slices are excluded: a wedge's bounding-box centre often lies outside the wedge, so
  // centroid sampling is unreliable; the dedicated pie-vs-`cardColor` check covers them.
  xychart: ['rect:not(.background)'],
  gantt: ['.exclude-range', '.today', '.crit0, .crit1, .crit2, .crit3'],
  gitGraph: ['.commit0, .commit1, .commit2, .commit3, .commit4, .commit5, .commit6, .commit7'],
  timeline: ['.lineWrapper line', '[class*="section-"] > rect'],
  mindmap: ['[class*="section-"] > rect']
}

// Shape-vs-background and pie-slice checks use computed style + `elementsFromPoint`.
function measureShapes(wrapper, diagramType, cardColor) {
  const checks = []

  for (const sel of SHAPE_SELECTORS[diagramType] || []) {
    wrapper.querySelectorAll(sel).forEach((shape, i) => {
      const tag = shape.tagName.toLowerCase()
      const cs = getComputedStyle(shape)
      const col = parseColor(tag === 'line' ? cs.stroke : cs.fill)
      if (!col || col.a === 0) return
      const r = shape.getBoundingClientRect()
      if (r.width <= 0 && r.height <= 0) return
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return
      const bg = resolveBackground(shape, x, y)
      const fg = applyBrightness({ ...col, a: effectiveAlpha(shape, col.a) }, accumulatedBrightness(shape))
      const apparent = over(fg, bg)
      const ratio = contrastRatio(apparent, bg)
      checks.push({ label: `${sel.split(',')[0].trim()}[${i}] vs background`, ratio, min: 3, pass: ratio >= 3 })
    })
  }

  // Pie slices: fill vs the known card colour (centroid sampling is unreliable for wedges),
  // plus the separator stroke vs the slice's own fill.
  if (diagramType === 'pie') {
    const card = parseColor(cardColor)
    wrapper.querySelectorAll('.pieCircle').forEach((slice, i) => {
      const cs = getComputedStyle(slice)
      const stroke = parseColor(cs.stroke)
      const fill = parseColor(cs.fill)
      if (fill && card) {
        const apparent = applyBrightness({ ...fill, a: effectiveAlpha(slice, fill.a) }, accumulatedBrightness(slice))
        const ratio = contrastRatio(over(apparent, card), card)
        checks.push({ label: `pie slice ${i} vs card`, ratio, min: 3, pass: ratio >= 3 })
      }
      if (stroke && fill && stroke.a > 0) {
        const ratio = contrastRatio(stroke, fill)
        checks.push({ label: `pie slice ${i} stroke vs fill`, ratio, min: 3, pass: ratio >= 3 })
      }
    })
  }

  return checks
}

// Collects every text leaf's viewport-clipped rect, minimum ratio and stable label without
// resolving any colour; the caller reads both colours from real screenshot pixels.
function collectTextItems(wrapper) {
  const items = []
  collectTextLeaves(wrapper).forEach((leaf) => {
    const r = leaf.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const left = Math.max(0, Math.floor(r.left))
    const top = Math.max(0, Math.floor(r.top))
    const right = Math.min(window.innerWidth, Math.ceil(r.left + r.width))
    const bottom = Math.min(window.innerHeight, Math.ceil(r.top + r.height))
    if (right <= left || bottom <= top) return
    const min = isLargeText(leaf) ? 3 : 4.5
    const ownerClasses = classesOf(leaf).split(' ').filter(Boolean).join('.')
    const parentClasses = classesOf(leaf.parentElement).split(' ').filter(Boolean).join('.')
    const tag = ownerClasses || parentClasses || leaf.tagName.toLowerCase()
    items.push({
      label: `text "${leaf.textContent.trim().slice(0, 28)}" [${tag}]`,
      min,
      rect: { left, top, right, bottom }
    })
  })
  return items
}

// Shared between prepare()/hideGlyphs()/cleanup(); the caller finishes one diagram/theme pair
// before starting the next, so only one is ever in flight.
let activeWrapper = null
let activeLeaves = []

// A hidden (`show: false`) BrowserWindow does not paint on every DOM mutation, so an immediate
// `capturePage()` can return the previous (sometimes blank) frame. Two consecutive
// `requestAnimationFrame` callbacks guarantee the layout/paint has actually been submitted.
function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })
}

// Renders `code` with the given theme, resolves the shape/pie checks synchronously, and collects
// every text leaf's rect for the caller to measure from screenshots. Leaves the SVG, glyphs
// visible, in the DOM until cleanup().
export async function prepare({ themeVariables, themeCSS, code, cardColor, diagramType }) {
  const mermaid = window.__mermaid
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'dark',
    themeVariables,
    themeCSS
  })
  let svg
  try {
    const id = 'mmd-' + Math.random().toString(36).slice(2)
    const rendered = await mermaid.render(id, code)
    svg = rendered.svg
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }

  const wrapper = document.createElement('div')
  wrapper.style.position = 'absolute'
  wrapper.style.top = '0'
  wrapper.style.left = '0'
  wrapper.style.margin = '0'
  wrapper.style.padding = '0'
  wrapper.style.background = cardColor
  wrapper.innerHTML = svg
  // Mermaid's `<svg>` has `width="100%"`, which resolves against nothing in this unconstrained
  // absolute wrapper and falls back to the 300x150 replaced-element default (a 2968px gantt
  // rendered ~300px wide), corrupting per-pixel sampling. Size it to its viewBox instead.
  const svgEl = wrapper.querySelector('svg')
  const viewBox = svgEl && svgEl.getAttribute('viewBox')
  const viewBoxParts = viewBox ? viewBox.trim().split(/\s+/).map(Number) : null
  if (svgEl && viewBoxParts && viewBoxParts.length === 4 && viewBoxParts[2] > 0 && viewBoxParts[3] > 0) {
    svgEl.style.width = `${viewBoxParts[2]}px`
    svgEl.style.height = `${viewBoxParts[3]}px`
  }
  document.body.appendChild(wrapper)
  void wrapper.offsetHeight // force layout before any getBoundingClientRect/elementsFromPoint call

  const shapeChecks = measureShapes(wrapper, diagramType, cardColor)
  const textItems = collectTextItems(wrapper)
  activeWrapper = wrapper
  activeLeaves = collectTextLeaves(wrapper)
  await waitForPaint() // see this file's own comment on waitForPaint for why this is required
  return { ok: true, shapeChecks, textItems }
}

// Hides every text leaf via `opacity: 0 !important` (paint only, so all other pixels match the
// visible capture). Not restored; cleanup() discards the diagram after the second screenshot.
// Awaits the same paint guarantee as prepare().
export async function hideGlyphs() {
  for (const leaf of activeLeaves) {
    leaf.style.setProperty('opacity', '0', 'important')
  }
  await waitForPaint()
  return true
}

// Discards the current diagram's DOM so the next prepare() call starts clean.
export function cleanup() {
  if (activeWrapper) activeWrapper.remove()
  activeWrapper = null
  activeLeaves = []
  return true
}
