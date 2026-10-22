// Issue #552/#1074 gate round 1 fix (Medium): `switch.tsx`'s own Off-state track draws
// `dark:data-[state=unchecked]:bg-foreground/40` -- since #1074 made `--foreground` itself
// translucent (90% alpha in every non-HC preset), Tailwind's `/40` opacity modifier MULTIPLIES
// with that existing alpha (0.9 * 0.4 = 0.36 effective), not a flat 40% the way it was when
// `--foreground` was solid (the same "translucent-source alpha multiplies, does not replace"
// correction `check-theme-contrast.mjs`'s own watermark check needed). Checked against both
// real surfaces a Switch renders on in this app: `--background` (Appearance settings page) and
// `--popover` (inside a menu/dialog). WCAG 1.4.11 non-text floor (3:1), real pairs, enforced.
//
// A brand-new file, not an addition to theme-contrast-pairs.mjs: that file is at its own 600-
// line soft cap with no baseline entry (the #806 file-size ratchet is lower-only), the same
// reason composer-selection-contrast.mjs's own header comment gives for living apart from it.
import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'

export function switchTrackContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const foreground = props['foreground']
    const background = props['background']
    const popover = props['popover']
    if (!foreground || !background || !popover) {
      rows.push({ themeId, fg: 'switch-off-track (foreground/40)', bg: 'background', min: 3, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const trackEntry = { raw: 'foreground/40', alpha: foreground.alpha * 0.4, linear: foreground.linear }
    for (const [bgName, bgEntry] of [['background', background], ['popover', popover]]) {
      const trackLinear = resolvedLinear(trackEntry, bgEntry)
      const ratio = contrastRatio(relativeLuminance(trackLinear), relativeLuminance(bgEntry.linear))
      rows.push({
        themeId,
        fg: 'switch-off-track (foreground/40)',
        bg: bgName,
        min: 3,
        ratio,
        pass: ratio >= 3,
        fgHex: linearToHex(trackLinear),
        bgHex: linearToHex(bgEntry.linear),
      })
    }
  }
  return rows
}
