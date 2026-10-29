import { contrastRatio, linearToHex, relativeLuminance, resolvedLinear } from './contrast-math.mjs'
import { hexToLinearSrgb } from './theme-contrast-pairs.mjs'

// #1043 (swatchPrimary vs --primary drift check), moved out of check-theme-contrast.mjs for the
// same #806 file-size reason as the composited checks that stayed in check-theme-contrast.mjs. Confirms
// `src/shared/themes.ts`'s own `swatch`/`swatchPrimary`/`titleBarOverlay.color`/
// `titleBarOverlay.symbolColor` literals never silently drift from the preset's REAL resolved
// `--background`/`--primary`/`--foreground` CSS tokens. #1074: `symbolColor` is now a
// composited check (`--foreground` alpha-blended over `--background`, `resolvedLinear`, a
// pass-through when alpha is 1) rather than byte-equality, since `--foreground` is translucent
// in every non-HC preset while `setTitleBarOverlay` takes an opaque hex. Returns
// `{ checkedCount, failCount, rows }` (one count per theme, a row only on failure).
export function swatchMetadataDriftCheck(themes, themeMetadata, declaredThemeIds) {
  let checkedCount = 0
  let failCount = 0
  const rows = []
  const fail = (id, fg, bg, note) => {
    failCount++
    rows.push({ themeId: id, fg, bg, min: 'n/a', ratio: null, pass: false, note })
  }
  for (const id of declaredThemeIds) {
    if (!(id in themes)) continue // already reported as a missing block above
    checkedCount++
    const meta = themeMetadata[id]
    const bgTag = `.theme-${id} --background`
    if (!meta) {
      fail(id, 'themes.ts swatch/titleBarOverlay', bgTag, `could not parse swatch/titleBarOverlay fields for '${id}' out of src/shared/themes.ts`)
      continue
    }
    const { background: bg, primary, foreground } = themes[id]
    const missing = ['background', 'primary', 'foreground', 'titlebar', 'divider'].find((name) => !themes[id][name])
    if (missing) {
      fail(id, `themes.ts (needs --${missing})`, bgTag, `'${id}' has no --${missing} token in globals.css to compare against`)
      continue
    }
    const actualBgHex = linearToHex(bg.linear)
    const actualPrimaryHex = linearToHex(primary.linear)
    const { titlebar, divider } = themes[id]
    const actualTitlebarHex = linearToHex(titlebar.linear)
    const actualSymbolColorHex = linearToHex(resolvedLinear(foreground, titlebar))
    const mismatches = []
    if (meta.swatch !== actualBgHex) mismatches.push(`swatch '${meta.swatch}' != --background '${actualBgHex}'`)
    if (meta.swatchPrimary !== actualPrimaryHex) mismatches.push(`swatchPrimary '${meta.swatchPrimary}' != --primary '${actualPrimaryHex}'`)
    if (meta.titleBarOverlayColor !== actualTitlebarHex) mismatches.push(`titleBarOverlay.color '${meta.titleBarOverlayColor}' != --titlebar '${actualTitlebarHex}'`)
    if (meta.symbolColor !== actualSymbolColorHex) mismatches.push(`titleBarOverlay.symbolColor '${meta.symbolColor}' != --foreground composited over --titlebar '${actualSymbolColorHex}'`)
    // Chrome band (#682): native caption symbols need 3:1 on the bar; High contrast dark has no soft divider, so its bottom edge needs a solid 4.5:1.
    const symbolRatio = contrastRatio(relativeLuminance(hexToLinearSrgb(meta.symbolColor)), relativeLuminance(titlebar.linear))
    if (symbolRatio < 3) mismatches.push(`titleBarOverlay.symbolColor '${meta.symbolColor}' is ${symbolRatio.toFixed(2)}:1 on --titlebar, under 3:1`)
    if (id === 'dark-high-contrast') {
      const edgeRatio = contrastRatio(relativeLuminance(resolvedLinear(divider, titlebar)), relativeLuminance(titlebar.linear))
      if (edgeRatio < 4.5) mismatches.push(`--divider bottom edge is ${edgeRatio.toFixed(2)}:1 on --titlebar, under 4.5:1`)
    }
    if (mismatches.length > 0) fail(id, 'themes.ts swatch/titleBarOverlay', bgTag, mismatches.join('; '))
  }
  return { checkedCount, failCount, rows }
}
