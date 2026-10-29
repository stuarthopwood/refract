// Spec 041 FR-006 (T12): contrast for the Chat navigation tokens -- Chat Find's match fills
// (`--find-match-bg`, `--find-match-current-bg`) and the scrollbar map's marks, track and
// viewport window (`--scrollbar-map-*`). The tokens live in `:root` with a `.theme-dark-high-
// contrast` override, so check-theme-contrast.mjs's per-theme parse never sees them; this module
// reads them from globals.css itself and resolves each one (`var(--x)` or `color-mix(in oklab,
// var(--x) N%, transparent)`) against every theme's own tokens. The `forced-colors` overrides
// are system colours (Highlight/HighlightText, CanvasText/Canvas), paired by the user agent, so
// they are not measurable here. Kept in its own module for the #806 file-size ratchet.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer/styles/globals.css')
const TOKEN_RE = /--(find-match-bg|find-match-current-bg|scrollbar-map-(?:user|agent|track|window)):\s*([^;]+);/g
const MIX_RE = /^color-mix\(\s*in\s+oklab\s*,\s*var\(\s*--([a-z0-9-]+)\s*\)\s+([\d.]+)%\s*,\s*transparent\s*\)$/i
const VAR_RE = /^var\(\s*--([a-z0-9-]+)\s*\)$/i

/** Raw declarations per scope: `:root` for the default, `.theme-<id>` for an override. */
function readDeclarations() {
  const source = readFileSync(cssPath, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutForcedColors = source.replace(/@media[^{]*forced-colors[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '')
  const scopes = { ':root': {} }
  for (const [, selector, body] of withoutForcedColors.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const name = selector.trim()
    if (name !== ':root' && !/^\.theme-[a-z0-9-]+$/.test(name)) continue
    for (const [, token, value] of body.matchAll(TOKEN_RE)) (scopes[name] ??= {})[token] = value.trim()
  }
  return scopes
}

function resolveToken(raw, props) {
  const mix = raw?.match(MIX_RE)
  if (mix) {
    const base = props[mix[1]]
    return base && { raw, alpha: base.alpha * (Number(mix[2]) / 100), linear: base.linear }
  }
  const ref = raw?.match(VAR_RE)
  return ref ? props[ref[1]] : undefined
}

export function findNavContrastRows(themes) {
  const scopes = readDeclarations()
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const declared = { ...scopes[':root'], ...scopes[`.theme-${themeId}`] }
    const tokens = Object.fromEntries(Object.keys(declared).map((name) => [name, resolveToken(declared[name], props)]))
    const background = props['background']
    const text = props['chat-foreground']
    const push = (fg, bg, min, ratio, fgHex, bgHex) => rows.push({ themeId, fg, bg, min, ratio, pass: ratio >= min, fgHex, bgHex })
    const missing = (fg, bg, min) => rows.push({ themeId, fg, bg, min, ratio: null, pass: false, note: 'token missing' })
    const lum = (entry, backdrop) => relativeLuminance(resolvedLinear(entry, backdrop))
    const opaque = (entry, backdrop) => ({ raw: 'composite', alpha: 1, linear: resolvedLinear(entry, backdrop) })

    for (const name of ['find-match-bg', 'find-match-current-bg']) {
      const fill = tokens[name]
      if (!fill || !background || !text) { missing('chat-foreground', name, 4.5); continue }
      const fillOnPage = opaque(fill, background)
      const textOnFill = resolvedLinear(text, fillOnPage)
      push('chat-foreground', `${name} on background`, 4.5, contrastRatio(relativeLuminance(textOnFill), relativeLuminance(fillOnPage.linear)), linearToHex(textOnFill), linearToHex(fillOnPage.linear))
    }
    const match = tokens['find-match-bg']
    const current = tokens['find-match-current-bg']
    if (match && current && background) {
      // The current match is also marked by a solid underline, so its fill only has to read as a
      // different, stronger fill than the other matches, not clear 3:1 on its own.
      push('find-match-current-bg', 'find-match-bg (both on background)', 1.2, contrastRatio(lum(current, background), lum(match, background)), linearToHex(resolvedLinear(current, background)), linearToHex(resolvedLinear(match, background)))
    }

    const track = tokens['scrollbar-map-track']
    if (!track || !background) { missing('scrollbar-map-*', 'scrollbar-map-track', 3); continue }
    const trackOnPage = opaque(track, background)
    const windowFill = tokens['scrollbar-map-window']
    for (const name of ['scrollbar-map-user', 'scrollbar-map-agent']) {
      const mark = tokens[name]
      if (!mark) { missing(name, 'scrollbar-map-track', 3); continue }
      push(name, 'scrollbar-map-track on background', 3, contrastRatio(lum(mark, trackOnPage), relativeLuminance(trackOnPage.linear)), linearToHex(resolvedLinear(mark, trackOnPage)), linearToHex(trackOnPage.linear))
      if (windowFill) {
        // The viewport window paints over the marks, so a mark inside it must still read.
        const windowOnTrack = opaque(windowFill, trackOnPage)
        push(name, 'scrollbar-map-window on track', 3, contrastRatio(lum(mark, windowOnTrack), relativeLuminance(windowOnTrack.linear)), linearToHex(resolvedLinear(mark, windowOnTrack)), linearToHex(windowOnTrack.linear))
      }
    }
    if (windowFill) {
      push('scrollbar-map-window', 'scrollbar-map-track (both on background)', 1.1, contrastRatio(lum(windowFill, trackOnPage), relativeLuminance(trackOnPage.linear)), linearToHex(resolvedLinear(windowFill, trackOnPage)), linearToHex(trackOnPage.linear))
    } else {
      missing('scrollbar-map-window', 'scrollbar-map-track', 1.1)
    }
  }
  return rows
}
