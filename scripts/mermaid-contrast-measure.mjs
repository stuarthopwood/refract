// Real-rendered-DOM contrast measurement, used by scripts/check-mermaid-contrast.mjs's Electron
// harness (loaded as an ES module from inside the renderer, never from Node).
//
// Quality-gate remediation (round 5): this REPLACED check-mermaid-contrast.mjs's round-4
// methodology, which extracted `fill:`/`stroke:` values by regex-matching Mermaid's generated
// `<style>` block TEXT, one diagram-specific pattern per check. That approach can only read a
// CSS rule's DECLARED value -- it never asks which rule actually WINS the cascade for a given
// element (specificity, `!important`, source order) or what shape is actually underneath a piece
// of text, which is exactly why it reported 182/182 PASS while two independent reviewers, each
// building their OWN from-scratch harness against the real rendered DOM, found 3 real failures.
//
// Quality-gate remediation (round 6): round 5's own replacement methodology -- computed style
// (`getComputedStyle`) for foreground, `document.elementsFromPoint` hit-testing + alpha-
// compositing for background -- had a real gap of the SAME class it was meant to fix: it only
// ever composited a hit-tested element's `fill` (SVG shapes) or `background-color` (HTML), never
// a painted STROKE (a `<path>` with `fill:none` but a visible `stroke`, e.g. a gitGraph branch
// line, or a bare `<line>`). A text label sitting on top of a stroked line was treated as if
// nothing were painted there at all, falling through to the wrapper's own opaque backdrop colour
// -- which is exactly how a gitGraph commit-id label sitting on its own bright branch line passed
// this harness at a reported 7.59:1 while measuring 1.73-2.87:1 in the real rendered pixels (two
// independent reviewers, each building their own from-scratch screenshot-pixel-diff harness,
// converged on the same real failure this script's computed-style approach could not see).
//
// Rather than enumerate yet another special case for "what else can paint a background" (stroke
// today; the next gap could just as easily be a `<pattern>`/`<linearGradient>` fill, a `mix-blend-
// mode`, or a CSS mask), this round replaces TEXT background/foreground resolution with the same
// general technique both reviewers' own harnesses already used and proved catches what computed-
// style modelling misses: render the diagram twice -- once with every text glyph visible, once
// with every glyph hidden (`opacity: 0 !important`, which changes paint but never layout, so every
// OTHER pixel on the page is pixel-identical between the two captures) -- and diff the two real
// screenshots. Wherever a leaf's own bounding rect differs between the two captures is real glyph
// ink; the "hidden" capture's colour at that exact pixel is DIRECTLY the real painted background
// (whatever combination of fill, stroke, gradient, filter, or opacity produced it, with zero
// enumeration needed), and the "visible" capture's colour at that same pixel is the real rendered
// foreground. `webContents.capturePage()` is only callable from the Electron MAIN process, not
// from inside the renderer this module runs in, so this module only PREPARES each diagram (render
// + collect every text leaf's bounding rect) and hides/restores glyphs on request; the actual two
// screenshots, the diff, and the contrast-ratio math over real pixels are performed by the caller
// (scripts/check-mermaid-contrast.mjs's generated Electron main script).
//
// Shape-vs-background and pie-slice checks are UNCHANGED from round 5 (computed style +
// `elementsFromPoint`, see `resolveBackground`/`measureShapes` below): the stroke-as-background gap
// above is specific to text sitting on top of another element's stroke, which none of this app's
// own shape/pie checks do (`BACKGROUND_FILL_TAGS` already deliberately excludes stroke-only `line`
// elements from contributing a phantom FILL layer to a SHAPE sitting on one, a different, already-
// correct concern -- see that set's own comment).

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
// label drawn directly on the diagram's own backdrop). Still used for shape-vs-background and pie
// checks (see this file's own header comment, round 6, for why TEXT no longer uses this).
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

// Shape-vs-background and pie-slice checks: UNCHANGED from round 5 -- see this file's own header
// comment (round 6) for why text no longer shares this computed-style/elementsFromPoint path.
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

// Collects every text leaf's bounding rect (clipped to the viewport), its minimum required ratio,
// and a stable label -- WITHOUT resolving a foreground or background colour itself. Both colours
// are instead read from real rendered screenshot pixels by the caller (see this file's own header
// comment, round 6).
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

// Threaded between prepare()/hideGlyphs()/cleanup(): the caller (check-mermaid-contrast.mjs's
// generated Electron main script) always finishes one diagram/theme pair -- prepare, screenshot,
// hide, screenshot, cleanup -- before starting the next, so only one diagram is ever in flight.
let activeWrapper = null
let activeLeaves = []

// Quality-gate remediation (round 6): a hidden (`show: false`) `BrowserWindow` does not paint on
// every DOM mutation the way a visible one does -- `webContents.capturePage()` called right after
// a layout-forcing `offsetHeight` read can still return the PREVIOUS (sometimes entirely blank)
// frame, because layout and paint/composite are separate pipeline stages and nothing before this
// forced either of the two real compositor frames below to actually run. Verified against a real
// capture: without this wait, a `capturePage()` immediately after rendering a diagram came back
// pure white (confirmed via `toBitmap()`/`toPNG()` inspection); two consecutive
// `requestAnimationFrame` callbacks (the first callback runs the queued layout/paint the mutation
// produced; the second only runs after THAT frame has actually been submitted) reliably fixed it.
function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })
}

// Renders `code` with the given theme, synchronously resolves every shape/pie check (unaffected by
// the stroke-as-background gap this round fixes -- see measureShapes's own comment), and collects
// every text leaf's bounding rect for the caller to measure from real screenshots. Leaves the
// rendered SVG, with every glyph still visible, in the DOM until cleanup() is called.
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
  // Quality-gate remediation (round 6): Mermaid's generated `<svg>` ships `width="100%"` plus a
  // `max-width: <viewBoxWidth>px` style -- sized correctly in the real app, where `MermaidBlock`'s
  // own container establishes a real containing-block width for that percentage to resolve
  // against. This bare wrapper (`position: absolute` with no declared width) gives the percentage
  // no real basis to resolve against, which verified against a real capture does NOT fall back to
  // the viewBox size -- it falls back to the CSS spec's classic 300x150 default replaced-element
  // size, silently rendering every diagram at a FRACTION of its real size (a gantt chart's
  // `viewBox="0 0 2968 292"` measured rendering at only ~300px wide, not 2968). Round 5's
  // computed-style/`elementsFromPoint` methodology never noticed because resolved COLOUR is
  // scale-invariant; round 6's real-pixel measurement is NOT -- text rendered at under 1/9th its
  // intended size loses enough anti-aliasing fidelity to make fill/background bleed together,
  // corrupting exactly the per-pixel sampling this round's methodology depends on. Explicitly
  // sizing the SVG to its own `viewBox` dimensions removes the percentage entirely, so it always
  // renders at native scale regardless of this wrapper's own (deliberately unconstrained) width.
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

// Hides every collected text leaf via `opacity: 0 !important` -- opacity changes paint only, never
// layout, so every OTHER pixel on the page (including any shape a label sits on top of) stays
// pixel-identical to the "visible" capture the caller already took; the only real difference
// between the two screenshots is the glyph ink itself. Does not restore -- the diagram is
// discarded by cleanup() right after the caller's second screenshot. Awaits the same real-paint
// guarantee prepare() does (see waitForPaint's own comment) before the caller's second
// `capturePage()` call.
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
