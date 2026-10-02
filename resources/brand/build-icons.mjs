// Regenerates the Windows app icon (build/icon.ico) and the two brand mark SVG sources
// (resources/brand/icon-full.svg, resources/brand/icon-small.svg) from the single geometry
// source of truth at src/renderer/components/brand/mark-geometry.json -- the same data
// src/renderer/components/brand/RefractMark.tsx renders as JSX, so the in-app mark and the app
// icon can never drift apart (resources/brand/README.md explains the design).
//
// Run with the project's own Electron binary (it needs Electron's renderer to rasterise SVG +
// a real webfont, not a generic headless-browser CLI -- see the README for why):
//
//   pnpm build:icon
//
// or directly:
//
//   node_modules/electron/dist/electron.exe resources/brand/build-icons.mjs   (Windows)
//   node_modules/.bin/electron resources/brand/build-icons.mjs                (macOS/Linux)
//
// Each generated SVG embeds the Archivo Black font as a data-URI @font-face INSIDE its own
// <style>, not relying on any host page's font-face: an SVG opened via <img>/background-image
// (and this script's own canvas drawImage() step, used to produce every icon size below the
// ~39px floor Windows enforces on a real window -- confirmed empirically, see README) renders in
// "image mode", which cannot see an enclosing page's fonts at all. A self-contained SVG renders
// correctly everywhere: inline in a live DOM, as a standalone file opened directly, or drawn to a
// canvas.

import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const geometry = JSON.parse(
  readFileSync(join(REPO_ROOT, 'src/renderer/components/brand/mark-geometry.json'), 'utf-8')
)
const fontPath = join(REPO_ROOT, 'src/renderer/assets/fonts/ArchivoBlack-Regular.woff2')
const fontBase64 = readFileSync(fontPath).toString('base64')
const fontFaceStyle = `<style>@font-face { font-family: 'Archivo Black'; src: url(data:font/woff2;base64,${fontBase64}) format('woff2'); font-weight: 400; }</style>`

const SMALL_SIZES = [16, 24, 32]
const FULL_SIZES = [48, 64, 128, 256]
const NATIVE_RASTER_SIZE = 1024 // the <img> intrinsic decode size canvas drawImage downsamples from

function dotGridMarkup(g) {
  const positions = Array.from({ length: g.dotGrid.count }, (_, i) => g.dotGrid.start + i * g.dotGrid.step)
  const circles = []
  for (const gy of positions) {
    for (const gx of positions) {
      circles.push(`<circle cx="${gx}" cy="${gy}" r="${g.dotGrid.radius}" fill="${g.dotGrid.color}" />`)
    }
  }
  return circles.join('\n        ')
}

function rayMarkup(g) {
  return g.rays
    .map((ray) => {
      const ty = g.glow.y + ray.dy
      const path =
        ray.dy === 0
          ? `M ${g.glow.x} ${g.glow.y} L ${g.fan.tipX} ${ty}`
          : `M ${g.glow.x} ${g.glow.y} L ${g.fan.elbowX} ${ty} L ${g.fan.tipX} ${ty}`
      return [
        `<path d="${path}" fill="none" stroke="${ray.color}" stroke-width="${g.fan.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`,
        `<circle cx="${g.fan.dot1X}" cy="${ty}" r="${g.fan.dotR}" fill="${ray.color}" />`,
        `<circle cx="${g.fan.dot2X}" cy="${ty}" r="${g.fan.dotR}" fill="${ray.color}" />`,
        `<path d="M ${g.fan.tipX - 2} ${ty - 13} L ${g.fan.tipX + 22} ${ty} L ${g.fan.tipX - 2} ${ty + 13} Z" fill="${ray.color}" />`
      ].join('\n        ')
    })
    .join('\n        ')
}

function piTextMarkup(piGlyph, fillRef) {
  return `<text x="${piGlyph.x}" y="${piGlyph.y}" font-family="${piGlyph.fontFamily}" font-size="${piGlyph.fontSize}" text-anchor="middle" dominant-baseline="central" fill="${fillRef}">&#960;</text>`
}

function backgroundMarkup(g) {
  const { background: bg, viewBox } = g
  return [
    `<rect x="${bg.outerInset}" y="${bg.outerInset}" width="${viewBox - bg.outerInset * 2}" height="${viewBox - bg.outerInset * 2}" rx="${bg.outerRx}" fill="${bg.outerFill}" />`,
    `<rect x="${bg.innerInset}" y="${bg.innerInset}" width="${viewBox - bg.innerInset * 2}" height="${viewBox - bg.innerInset * 2}" rx="${bg.innerRx}" fill="url(#bg-grad)" />`
  ].join('\n  ')
}

function sharedDefs(g) {
  const { background: bg, piGlyph } = g
  return `<linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg.bgGradFrom}" />
      <stop offset="100%" stop-color="${bg.bgGradTo}" />
    </linearGradient>
    <linearGradient id="pi-grad" x1="0" y1="0" x2="1" y2="0.15">
      <stop offset="0%" stop-color="${piGlyph.gradFrom}" />
      <stop offset="100%" stop-color="${piGlyph.gradTo}" />
    </linearGradient>`
}

/** The detailed mark: dot-grid background, glow, beam, five-ray fan, pi glyph. Used for the
 * in-app header (via RefractMark.tsx) and for 48px-and-up icon tiers. */
function buildFullSvgMarkup(g, px) {
  const { viewBox, background: bg, glow } = g
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" width="${px}" height="${px}">
  <defs>
    ${sharedDefs(g)}
    <radialGradient id="flare" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="1" />
      <stop offset="45%" stop-color="#ffffff" stop-opacity="0.9" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <filter id="blur-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" /></filter>
    <filter id="blur-tight" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
    <clipPath id="inner-clip"><rect x="${bg.innerInset}" y="${bg.innerInset}" width="${viewBox - bg.innerInset * 2}" height="${viewBox - bg.innerInset * 2}" rx="${bg.innerRx}" /></clipPath>
  </defs>
  ${fontFaceStyle}
  ${backgroundMarkup(g)}
  <g clip-path="url(#inner-clip)">
        ${dotGridMarkup(g)}
    <line x1="${glow.beamStartX}" y1="${glow.y}" x2="${glow.x}" y2="${glow.y}" stroke="#ffffff" stroke-width="${glow.beamWidthSoft}" stroke-linecap="round" opacity="0.35" filter="url(#blur-soft)" />
    <line x1="${glow.beamStartX}" y1="${glow.y}" x2="${glow.x}" y2="${glow.y}" stroke="#ffffff" stroke-width="${glow.beamWidthCore}" stroke-linecap="round" />
        ${rayMarkup(g)}
    <circle cx="${glow.x}" cy="${glow.y}" r="${glow.flareR}" fill="url(#flare)" filter="url(#blur-tight)" />
    <circle cx="${glow.x}" cy="${glow.y}" r="${glow.coreR}" fill="#ffffff" />
    ${piTextMarkup(g.piGlyph, 'url(#pi-grad)')}
  </g>
</svg>
`
}

/** The simplified mark: glyph only, no dot grid/beam/fan. The five thin rays and their dots
 * compress into a muddy smear once downsampled below ~48px, so small icon tiers drop the fan
 * entirely rather than shrink it (resources/brand/README.md). Used for 16/24/32px icon tiers. */
function buildSmallSvgMarkup(g, px) {
  const { viewBox } = g
  // The small variant has no fan competing for space, so it gets its own centred, larger glyph
  // position (piGlyphSmall) rather than reusing the full design's beam-side x.
  const smallGlyph = { ...g.piGlyph, ...g.piGlyphSmall }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" width="${px}" height="${px}">
  <defs>${sharedDefs(g)}</defs>
  ${fontFaceStyle}
  ${backgroundMarkup(g)}
  ${piTextMarkup(smallGlyph, 'url(#pi-grad)')}
</svg>
`
}

/** Builds a minimal multi-resolution .ico: a 6-byte ICONDIR header, one 16-byte ICONDIRENTRY per
 * image, then the raw PNG bytes back to back (Windows has accepted PNG-compressed ICO entries
 * since Vista). `images` is `[{ size, png: Buffer }]`. */
function buildIco(images) {
  const headerSize = 6 + 16 * images.length
  let offset = headerSize
  const entries = []
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size < 256 ? size : 0, 0) // width, 0 means 256
    entry.writeUInt8(size < 256 ? size : 0, 1) // height
    entry.writeUInt8(0, 2) // color palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8) // image data size
    entry.writeUInt32LE(offset, 12) // image data offset
    entries.push(entry)
    offset += png.length
  }
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4) // image count
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

/** Draws one self-contained SVG (data-URI <img>, "image mode") to an off-screen canvas at every
 * requested size with high-quality smoothing, and returns `{ size: Buffer }` PNGs. A single
 * normal-sized window hosts this -- Windows enforces a real minimum window size well above any
 * of our icon tiers (empirically ~32x39px even with useContentSize:true), so rendering each small
 * size directly as its own tiny window is not reliable; canvas-downsampling from one native-size
 * raster inside a normal window sidesteps that floor entirely. */
async function rasterizeSizes(win, svgMarkup, sizes) {
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svgMarkup, 'utf-8').toString('base64')}`
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const img = new Image(${NATIVE_RASTER_SIZE}, ${NATIVE_RASTER_SIZE});
      img.src = ${JSON.stringify(svgDataUrl)};
      await img.decode();
      const out = {};
      for (const size of ${JSON.stringify(sizes)}) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        out[size] = canvas.toDataURL('image/png');
      }
      return out;
    })()
  `)
  const pngs = {}
  for (const [size, dataUrl] of Object.entries(result)) {
    pngs[size] = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')
  }
  return pngs
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  let win
  try {
    const fullSvg1024 = buildFullSvgMarkup(geometry, geometry.viewBox)
    const smallSvg1024 = buildSmallSvgMarkup(geometry, geometry.viewBox)

    // Regenerate the checked-in SVG sources from the same geometry the icon is rendered from,
    // so they can never drift from what build/icon.ico and RefractMark.tsx actually draw.
    writeFileSync(join(REPO_ROOT, 'resources/brand/icon-full.svg'), fullSvg1024)
    writeFileSync(join(REPO_ROOT, 'resources/brand/icon-small.svg'), smallSvg1024)

    win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: {} })
    await win.loadURL('data:text/html,<html><body style="margin:0"></body></html>')

    const smallPngs = await rasterizeSizes(win, smallSvg1024, SMALL_SIZES)
    const fullPngs = await rasterizeSizes(win, fullSvg1024, FULL_SIZES)

    const images = [
      ...SMALL_SIZES.map((size) => ({ size, png: smallPngs[size] })),
      ...FULL_SIZES.map((size) => ({ size, png: fullPngs[size] }))
    ]

    const ico = buildIco(images)
    writeFileSync(join(REPO_ROOT, 'build/icon.ico'), ico)

    console.log(`Wrote build/icon.ico (${ico.length} bytes, sizes ${images.map((i) => i.size).join(',')})`)
    console.log('Wrote resources/brand/icon-full.svg and resources/brand/icon-small.svg')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.quit()
  }
})
