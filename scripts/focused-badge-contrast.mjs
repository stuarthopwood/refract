// Focused-badge text sits on a translucent coloured fill, so it needs a two-step alpha composite
// that a plain PAIRS row cannot express. Split out to stay under the #806 file-size baseline.
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

const lum = (entry, backdrop) => relativeLuminance(resolvedLinear(entry, backdrop))

export function focusedBadgeContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const activeIndicator = props['active-indicator']
    const background = props['background']
    const activeIndicatorForeground = props['active-indicator-foreground']
    const badgeFill = props['focused-badge-bg']
    const tint = props['pane-focused']
    const surface1 = props['surface-1']
    const edge = props['pane-focused-edge'] // `transparent` is left unparsed, so undefined means no edge
    if (!activeIndicator || !background || !activeIndicatorForeground || !badgeFill || !tint || !surface1) {
      rows.push({ themeId, fg: 'active-indicator-foreground', bg: 'focused-badge (focused-badge-bg on pane-focused)', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const tintBackdrop = { raw: 'pane-focused', alpha: 1, linear: resolvedLinear(tint, background) }
    const tintLum = relativeLuminance(tintBackdrop.linear)
    const push = (fg, bg, min, ratio, fgHex, bgHex) => rows.push({ themeId, fg, bg, min, ratio, pass: ratio >= min, fgHex, bgHex })
    // Worst of the fill over the tint and over the header backdrop.
    for (const [label, base] of [['pane-focused', tintBackdrop], ['background', background]]) {
      const badgeLinear = resolvedLinear(badgeFill, base)
      const fgLinear = resolvedLinear(activeIndicatorForeground, { raw: 'focused-badge', alpha: 1, linear: badgeLinear })
      push('active-indicator-foreground', `focused-badge (focused-badge-bg on ${label})`, 4.5, contrastRatio(relativeLuminance(fgLinear), relativeLuminance(badgeLinear)), linearToHex(fgLinear), linearToHex(badgeLinear))
    }
    for (const [name, min] of [['foreground', 4.5], ['chat-foreground', 4.5], ['muted-foreground', 4.5], ['accent-text', 4.5], ['border', 3], ['ring', 3], ['active-indicator', 3]]) {
      const entry = props[name]
      if (!entry) { rows.push({ themeId, fg: name, bg: 'pane-focused', min, ratio: null, pass: false, note: 'token missing' }); continue }
      const fgLinear = resolvedLinear(entry, tintBackdrop)
      push(name, 'pane-focused', min, contrastRatio(relativeLuminance(fgLinear), tintLum), linearToHex(fgLinear), linearToHex(tintBackdrop.linear))
    }
    const muted = props['muted']
    if (muted) {
      const bubble = { raw: 'bubble', alpha: 1, linear: resolvedLinear({ raw: 'muted/50', alpha: 0.5, linear: muted.linear }, tintBackdrop) }
      for (const name of ['accent-text', 'chat-foreground']) {
        const fgLinear = resolvedLinear(props[name], bubble)
        push(name, 'user-bubble (muted/50 on pane-focused)', 4.5, contrastRatio(relativeLuminance(fgLinear), relativeLuminance(bubble.linear)), linearToHex(fgLinear), linearToHex(bubble.linear))
      }
    }
    const surfaceBackdrop = { raw: 'surface-1', alpha: 1, linear: resolvedLinear(surface1, background) }
    for (const [name, min] of [['foreground', 4.5], ['muted-foreground', 4.5], ['border', 3]]) {
      const fgLinear = resolvedLinear(props[name], surfaceBackdrop)
      push(name, 'surface-1 (scroll-to-bottom / attachment-remove)', min, contrastRatio(relativeLuminance(fgLinear), relativeLuminance(surfaceBackdrop.linear)), linearToHex(fgLinear), linearToHex(surfaceBackdrop.linear))
    }
    // High contrast has tint == background (no tint); its edge carries 3:1 instead.
    const bgLum = lum(background, background), s1Lum = relativeLuminance(surfaceBackdrop.linear)
    const ladderOk = /^light/.test(themeId) ? bgLum >= tintLum - 1e-9 && tintLum > s1Lum : bgLum <= tintLum + 1e-9 && tintLum < s1Lum
    rows.push({ themeId, fg: 'ladder', bg: 'background <= pane-focused < surface-1', min: 0, ratio: tintLum, pass: ladderOk, note: ladderOk ? undefined : 'tint out of ladder order' })
    if (edge && edge.alpha > 0) {
      const edgeLinear = resolvedLinear(edge, background)
      push('pane-focused-edge', 'background', 3, contrastRatio(relativeLuminance(edgeLinear), relativeLuminance(resolvedLinear(background, background))), linearToHex(edgeLinear), linearToHex(background.linear))
    }
  }
  return rows
}
