// Gate round 3 fix (Main, #1074 follow-up, item 4), moved out of theme-contrast-pairs.mjs for
// the same #806 file-size ratchet reason switch-track-contrast.mjs/composer-selection-
// contrast.mjs already were: the main module had grown past its own recorded 600-line baseline.
//
// The "Focused" session badge (`ChatHeader.tsx`) composites its text over `active-indicator/20`
// on `background` -- a coloured, non-neutral fill, FR-023's "stays solid" exception, same
// category as `theme-contrast-pairs.mjs`'s own `userBubbleContrastRows`.
// `--active-indicator-foreground` is the dedicated solid token (gate round 3, plain white in
// every preset), enforced here a real PAIRS-style row cannot express (the backdrop needs the
// same two-step alpha composite `userBubbleContrastRows` uses).
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

//
// #684 (focused pane tint): the same function also returns the rows measured on `--pane-focused`
// (the body tint), the badge fill composited over it (the badge sits in the header, which is
// untinted, but the fill token is checked on both), the user bubble composited over the tint,
// the scroll-to-bottom / attachment-remove buttons on `--surface-1`, and the surface ladder
// `--background` <= `--pane-focused` < `--surface-1` (high contrast: tint == background, so the
// edge is checked instead). Kept here because `check-theme-contrast.mjs` is at its #806 baseline.
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
    // The badge text, over its fill composited on the header's own backdrop (`--titlebar`, the
    // header surface) and on the tint (worst of the two).
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
    const accent = props['accent']
    if (accent) {
      const bubble = { raw: 'bubble', alpha: 1, linear: resolvedLinear({ raw: 'accent/50', alpha: 0.5, linear: accent.linear }, tintBackdrop) }
      for (const name of ['accent-text', 'chat-foreground']) {
        const fgLinear = resolvedLinear(props[name], bubble)
        push(name, 'user-bubble (accent/50 on pane-focused)', 4.5, contrastRatio(relativeLuminance(fgLinear), relativeLuminance(bubble.linear)), linearToHex(fgLinear), linearToHex(bubble.linear))
      }
    }
    // The two buttons moved onto `--surface-1` so they stay readable over the tint.
    const surfaceBackdrop = { raw: 'surface-1', alpha: 1, linear: resolvedLinear(surface1, background) }
    for (const [name, min] of [['foreground', 4.5], ['muted-foreground', 4.5], ['border', 3]]) {
      const fgLinear = resolvedLinear(props[name], surfaceBackdrop)
      push(name, 'surface-1 (scroll-to-bottom / attachment-remove)', min, contrastRatio(relativeLuminance(fgLinear), relativeLuminance(surfaceBackdrop.linear)), linearToHex(fgLinear), linearToHex(surfaceBackdrop.linear))
    }
    // Ladder: `--background` <= `--pane-focused` < `--surface-1` (a tint equal to the background,
    // high contrast, is the "no tint" case; its 2px edge carries 3:1 above instead).
    const ladderOk = lum(background, background) <= tintLum + 1e-9 && tintLum < relativeLuminance(surfaceBackdrop.linear)
    rows.push({ themeId, fg: 'ladder', bg: 'background <= pane-focused < surface-1', min: 0, ratio: tintLum, pass: ladderOk, note: ladderOk ? undefined : 'tint out of ladder order' })
    if (edge && edge.alpha > 0) {
      const edgeLinear = resolvedLinear(edge, background)
      push('pane-focused-edge', 'background', 3, contrastRatio(relativeLuminance(edgeLinear), relativeLuminance(resolvedLinear(background, background))), linearToHex(edgeLinear), linearToHex(background.linear))
    }
  }
  return rows
}
