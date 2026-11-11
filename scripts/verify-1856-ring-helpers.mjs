// Page-side probes for verify-tauri-1856.mjs: the inset focus ring's computed colour and contrast, and whether anything
// paints over the ring's 3px band. Colours are resolved by the browser (canvas), so oklch/oklab/color-mix just work.
import { writeFileSync } from 'node:fs';

const PROBES = String.raw`(() => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const SENTINEL = '#010203';
  const paint = (css) => {
    ctx.fillStyle = SENTINEL;
    ctx.fillStyle = css;
    if (ctx.fillStyle === SENTINEL && css.replace(/\s/g, '') !== 'rgb(1,2,3)') throw new Error('canvas cannot parse colour ' + css);
    ctx.fillRect(0, 0, 1, 1);
  };
  const alphaOf = (css) => { ctx.clearRect(0, 0, 1, 1); paint(css); return ctx.getImageData(0, 0, 1, 1).data[3]; };
  const flatten = (layers) => {
    ctx.clearRect(0, 0, 1, 1);
    layers.forEach(paint);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a !== 255) throw new Error('background stack is not opaque (alpha ' + a + ')');
    return [r, g, b];
  };
  const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  const backdrop = (el) => { const out = []; for (let n = el; n; n = n.parentElement) out.unshift(getComputedStyle(n).backgroundColor); return out; };
  const varColor = (name) => {
    const p = document.createElement('div');
    p.style.color = 'var(' + name + ')';
    document.body.appendChild(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  };
  const contrastOf = (el, css) => {
    const stack = backdrop(el);
    const bg = flatten(stack);
    const fg = flatten([...stack, css]);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return { ratio: (hi + 0.05) / (lo + 0.05), ring: hex(fg), background: hex(bg), css };
  };
  const ring = (el) => {
    for (const seg of getComputedStyle(el).boxShadow.split(/,(?![^()]*\))/).map((s) => s.trim())) {
      const px = seg.match(/-?[\d.]+px/g) || [];
      if (!seg.includes('inset') || !(parseFloat(px[3]) > 0)) continue;
      const color = seg.replace('inset', '').replace(/-?[\d.]+px/g, '').trim();
      if (alphaOf(color) > 0) return { spreadPx: parseFloat(px[3]), color };
    }
    return { spreadPx: 0, color: null };
  };
  const paints = (n) => {
    const s = getComputedStyle(n);
    const ownText = Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim());
    const bg = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s['border' + side + 'Width']) > 0 && s['border' + side + 'Style'] !== 'none');
    return ownText || bg || border || n.tagName.toLowerCase() === 'svg';
  };
  const edges = (v) => {
    const vb = v.getBoundingClientRect();
    const gaps = { top: Infinity, left: Infinity, right: Infinity, bottom: Infinity };
    for (const n of v.querySelectorAll('*')) {
      if (!paints(n)) continue;
      const b = n.getBoundingClientRect();
      // Only what is on screen can sit under the ring; rows scrolled out of the viewport say nothing about its edges.
      if (!b.width || !b.height || b.bottom <= vb.top || b.top >= vb.bottom) continue;
      gaps.top = Math.min(gaps.top, b.top - vb.top);
      gaps.left = Math.min(gaps.left, b.left - vb.left);
      gaps.right = Math.min(gaps.right, vb.right - b.right);
      gaps.bottom = Math.min(gaps.bottom, vb.bottom - b.bottom);
    }
    const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && v.contains(e) && !e.closest('[data-slot="scroll-area-scrollbar"]'); };
    const mx = vb.left + vb.width / 2;
    const my = vb.top + vb.height / 2;
    return {
      gaps,
      clear: { top: hit(mx, vb.top + 1.5), bottom: hit(mx, vb.bottom - 1.5), left: hit(vb.left + 1.5, my), right: hit(vb.right - 1.5, my) },
      box: { left: vb.left, top: vb.top, width: vb.width, height: vb.height }
    };
  };
  return { ring, edges, contrastOf, varColor };
})()`;

/** Installs the probes once per page load. */
export async function installRingProbes(cdp) {
  await cdp.evaluate(`window.__ring1856 = ${PROBES}`);
}

/** `{ spreadPx, color }` of the element's inset ring; `spreadPx` is 0 when no visible inset ring is painted. */
export const readRing = (cdp, elExpr) => cdp.evaluate(`window.__ring1856.ring(${elExpr})`);

/** Where painted content sits relative to the ring band, and whether the element's four inner edges hit-test to its own content. */
export const readEdges = (cdp, elExpr) => cdp.evaluate(`window.__ring1856.edges(${elExpr})`);

/** WCAG contrast of the ring colour and of the old `--focus-glow` token, each over the element's real backdrop. */
export async function measureRingContrast(cdp, elExpr, ringCss) {
  return cdp.evaluate(`(() => {
    const p = window.__ring1856;
    const el = ${elExpr};
    return { before: p.contrastOf(el, p.varColor('--focus-glow')), after: p.contrastOf(el, ${JSON.stringify(ringCss)}) };
  })()`);
}

/** Zoomed capture of a page rectangle, for pixel-level evidence of a thin ring. */
export async function shotClip(cdp, file, box, scale = 4) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
