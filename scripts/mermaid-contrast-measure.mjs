// Real-rendered-DOM contrast measurement, used by scripts/check-mermaid-contrast.mjs's Electron
// harness (loaded as an ES module from inside the renderer, never from Node).
//
// Quality-gate remediation (round 5): this REPLACES check-mermaid-contrast.mjs's round-4
// methodology, which extracted `fill:`/`stroke:` values by regex-matching Mermaid's generated
// `<style>` block TEXT, one diagram-specific pattern per check. That approach can only read a
// CSS rule's DECLARED value -- it never asks which rule actually WINS the cascade for a given
// element (specificity, `!important`, source order) or what shape is actually underneath a piece
// of text, which is exactly why it reported 182/182 PASS while two independent reviewers, each
// building their OWN from-scratch harness against the real rendered DOM, found 3 real failures.
//
// This module instead renders each fixture for real, inserts the resulting SVG into a live page,
// and for every actually-rendered text/shape element:
// 1. Reads its colour via `getComputedStyle` -- the browser's own cascade resolution, so it is
//    automatically correct about specificity/`!important`/source order without this file having
//    to simulate any of that.
// 2. Finds whatever REAL shape is painted underneath it via `document.elementsFromPoint`, walking
//    every element the browser's own hit-test reports at that point (not an assumed `--card`
//    baseline), and alpha-composites every opaque/semi-opaque layer found, bottom-up (Porter-Duff
//    "over"), so partial opacity is blended rather than ignored.
// 3. Applies any `filter: brightness(N%)` CSS on the element or an ancestor (the one real case
//    this app's own Mermaid output uses -- Timeline's `.eventWrapper`) to the resolved colour
//    before compositing, so a post-paint brightening Mermaid applies is reflected in the measured
//    ratio, not just the declared pre-filter value. KNOWN LIMITATION: only `brightness()` is
//    modelled; `contrast()`, `saturate()`, `hue-rotate()`, `grayscale()`, `sepia()`, `invert()`,
//    `blur()`, and `drop-shadow()` are not -- a future fixture relying on one of those would
//    silently under- or over-state its measured contrast until this is widened to match.
//
// Every leaf text node (SVG `<text>`/`<tspan>` AND foreignObject HTML text) is measured this way
// generically, for every diagram type, rather than one hand-picked selector per diagram -- so a
// future Mermaid markup-shape change, or a label type this file's author never thought to check,
// still gets measured instead of silently skipped.

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
  // Any other CSS colour syntax (named colours, `hsl()`, etc.) -- resolve it the same way the
  // browser itself would, via a throwaway element's own computed style, rather than hand-rolling
  // a parser for every CSS colour grammar.
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
// Subset of SHAPE_TAGS that can contribute a FILL-based background layer when resolving what is
// visually behind another element: excludes 'line', which is stroke-only -- its computed `fill`
// (default/inherited, often opaque black per the SVG initial value) is never actually painted as
// a background area, so including it would inject a phantom dark layer under anything sitting on
// top of a line (e.g. a gitGraph commit dot drawn on its own branch line).
const BACKGROUND_FILL_TAGS = new Set(['rect', 'path', 'circle', 'ellipse', 'polygon', 'polyline'])

// Resolves the real, composited background colour actually visible beneath `el` at viewport point
// (x, y): walks every element the browser's own `elementsFromPoint` hit-test reports there, in
// paint order, skipping `el` itself and any of its ancestors, and alpha-composites every painted
// layer found (shape fill, or HTML background-color), applying each layer's own accumulated
// `brightness()` filter first, bottom-up. The wrapper this script renders every diagram into
// always has an opaque, real CSS `background-color` (the theme's own `--card` value), so this is
// guaranteed to bottom out at a known-opaque base even when no Mermaid shape is underneath (e.g. a
// label drawn directly on the diagram's own backdrop).
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

function textForeground(el) {
  const cs = getComputedStyle(el)
  const raw = el instanceof HTMLElement ? cs.color : cs.fill
  const col = parseColor(raw)
  if (!col) return null
  return applyBrightness({ ...col, a: effectiveAlpha(el, col.a) }, accumulatedBrightness(el))
}

function samplePoints(el) {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return []
  const cy = r.top + r.height / 2
  return [0.2, 0.5, 0.8]
    .map((f) => ({ x: r.left + r.width * f, y: cy }))
    .filter((p) => p.x >= 0 && p.y >= 0 && p.x < window.innerWidth && p.y < window.innerHeight)
}

function classesOf(el) {
  if (!el) return ''
  if (typeof el.className === 'string') return el.className
  if (el.className && el.className.baseVal !== undefined) return el.className.baseVal
  return el.getAttribute('class') || ''
}

// Every leaf text node Mermaid actually renders, regardless of diagram type: SVG `<text>` (or its
// `<tspan>` children, when it has any -- multi-line labels are drawn as several positioned
// `<tspan>`s, not a single `<text>` with a flat `textContent`) and foreignObject HTML text leaves
// (Journey's `<div class="label">`).
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

// Known graphical-object (non-text, WCAG 1.4.11, >=3:1) elements this app's own fixtures render,
// per diagram type. These selectors only pick WHICH real elements to inspect -- the colour read
// off each is always `getComputedStyle`, resolved to whatever rule actually won the cascade for
// that element, never a value assumed or pattern-matched out of the stylesheet text.
const SHAPE_SELECTORS = {
  // Pie slices are excluded here deliberately: a wedge's bounding-box CENTRE is frequently
  // outside its own wedge (or inside a DIFFERENT slice), so centroid-point sampling against
  // "whatever's behind this element" is geometrically unreliable for them -- see the dedicated
  // pie-vs-`cardColor` check below instead, which every slice is guaranteed to need regardless
  // of its own shape (nothing but the page itself is ever behind a pie slice).
  xychart: ['rect:not(.background)'],
  gantt: ['.exclude-range', '.today', '.crit0, .crit1, .crit2, .crit3'],
  gitGraph: ['.commit0, .commit1, .commit2, .commit3, .commit4, .commit5, .commit6, .commit7'],
  timeline: ['.lineWrapper line', '[class*="section-"] > rect'],
  mindmap: ['[class*="section-"] > rect']
}

function measure(wrapper, diagramType, cardColor) {
  const checks = []

  for (const leaf of collectTextLeaves(wrapper)) {
    const fg = textForeground(leaf)
    if (!fg) continue
    const points = samplePoints(leaf)
    if (points.length === 0) continue
    let worst = null
    for (const p of points) {
      const bg = resolveBackground(leaf, p.x, p.y)
      const apparentFg = over(fg, bg)
      const ratio = contrastRatio(apparentFg, bg)
      if (!worst || ratio < worst.ratio) worst = { ratio, bg, fg: apparentFg }
    }
    const min = isLargeText(leaf) ? 3 : 4.5
    const ownerClasses = classesOf(leaf).split(' ').filter(Boolean).join('.')
    const parentClasses = classesOf(leaf.parentElement).split(' ').filter(Boolean).join('.')
    const tag = ownerClasses || parentClasses || leaf.tagName.toLowerCase()
    checks.push({
      label: `text "${leaf.textContent.trim().slice(0, 28)}" [${tag}]`,
      ratio: worst.ratio,
      min,
      pass: worst.ratio >= min
    })
  }

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

  // Pie slices: fill vs the known page/card colour (not a hit-tested background -- see
  // SHAPE_SELECTORS's own comment on why centroid sampling is unreliable for wedges), plus the
  // separator stroke vs the slice's own fill, both read directly off the same element.
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

export async function run({ themeVariables, themeCSS, code, cardColor, diagramType }) {
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
  document.body.appendChild(wrapper)
  void wrapper.offsetHeight // force layout before any getBoundingClientRect/elementsFromPoint call

  try {
    const checks = measure(wrapper, diagramType, cardColor)
    return { ok: true, checks }
  } finally {
    wrapper.remove()
  }
}
