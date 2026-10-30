// Switch Off-state track (`bg-foreground/40`) must meet WCAG 1.4.11 (3:1) on `--background` and
// `--popover`. `--foreground` is 90% alpha (#1074), so `/40` multiplies to 0.36 effective.
// Separate file: theme-contrast-pairs.mjs is at the #806 size cap.
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
