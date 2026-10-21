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

export function focusedBadgeContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const activeIndicator = props['active-indicator']
    const background = props['background']
    const activeIndicatorForeground = props['active-indicator-foreground']
    if (!activeIndicator || !background || !activeIndicatorForeground) {
      rows.push({ themeId, fg: 'active-indicator-foreground', bg: 'focused-badge (active-indicator/20 on background)', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const badgeLinear = resolvedLinear({ raw: 'active-indicator/20', alpha: 0.2, linear: activeIndicator.linear }, background)
    const badge = { raw: 'focused-badge', alpha: 1, linear: badgeLinear }
    const fgLinear = resolvedLinear(activeIndicatorForeground, badge)
    const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(badgeLinear))
    rows.push({ themeId, fg: 'active-indicator-foreground', bg: 'focused-badge (active-indicator/20 on background)', min: 4.5, ratio, pass: ratio >= 4.5, fgHex: linearToHex(fgLinear), bgHex: linearToHex(badgeLinear) })
  }
  return rows
}
