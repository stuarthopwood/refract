// Per-theme Mermaid variable data, split out of mermaidTheme.ts to stay under the file-size baseline (#551, #806).

import type { ThemeId } from './themes'
import type { MermaidThemeVariables } from './mermaidTheme'

// Palette shared by `dark` and `obsidian`: the bright qualitative palettes and task-text roles
// were verified to clear every contrast floor on both themes' canvases. Obsidian overrides its surface-tied fields.
const DARK_FAMILY: MermaidThemeVariables = {
  background: '#0a0a0a',
  // Mermaid's 'dark' base hardcodes the real node fill to `#1f2020`, ignoring `primaryColor`; the real ratio vs that is 13.33:1 (#1074).
  primaryColor: '#1f1f1f',
  primaryTextColor: '#e8e8e8',
  // 0.9 tier (white at 90% alpha over `--card`), identical to `primaryTextColor`.
  titleColor: '#e8e8e8',
  primaryBorderColor: '#747474',
  // Muted line/stroke on the page background (white at 60% alpha, 7.30:1); `pieOuterStrokeColor` and `cScaleInv*` share it.
  lineColor: '#9d9d9d',
  // The accent matches `--secondary`, so the third fill sits one step lighter to stay distinct.
  secondaryColor: '#2b2b2b',
  tertiaryColor: '#3d3d3d',
  // General diagram text on the page background (15.93:1); `taskTextOutsideColor` is the same role.
  textColor: '#e7e7e7',
  darkMode: true,
  altSectionBkgColor: '#2b2b2b',
  sectionBkgColor: '#2b2b2b',
  sectionBkgColor2: '#2b2b2b',
  // Note text on `--popover` (0.78 tier, 11.15:1).
  noteBkgColor: '#1f1f1f',
  noteTextColor: '#cccccc',
  // Pure black clears >=9:1 on Mermaid's done (`lightgrey`) and active (`#81B1DB`) bars; a plain crit bar uses `taskTextColor` instead.
  taskTextDarkColor: '#000000',
  taskTextOutsideColor: '#e7e7e7',
  // Not softened: the label sits on a coloured bar fill, and the 0.9 tier measured only 4.23:1 on `critBkgColor`.
  // Clears >=5:1 on the plain/active/crit bars; the done bar is handled via `getMermaidThemeCSS`'s `themeCSS`.
  taskTextClickableColor: '#fafafa',
  // The plain crit bar's own inside label on a coloured fill, so it stays solid; Mermaid's default measured 3.07:1 on `critBkgColor`.
  taskTextColor: '#fafafa',
  // Mermaid's default crit fill cannot clear 4.5:1 with light text and 3:1 against `--card` at once;
  // this one measures 5.01:1 vs `taskTextColor`, 3.15:1 vs `--card` (3.14:1 on Obsidian's lighter card).
  critBkgColor: '#db0000',
  // Fixed hue-separated palette, each >=6.98:1 vs the canvas and >=8.89:1 vs `pieSectionTextColor`.
  // Mermaid reads `pie1`-`pie12` directly, so unlike `cScale11` this stays bright.
  pie1: '#76a9ff',
  pie2: '#21df9b',
  pie3: '#ffb734',
  pie4: '#d492ff',
  pie5: '#ff8492',
  pie6: '#ffe066',
  pie7: '#9bf6ff',
  pie8: '#ffadad',
  pie9: '#b3b3ff',
  pie10: '#7affc4',
  pie11: '#ffab73',
  pie12: '#c9ff6b',
  pieOpacity: 1,
  pieSectionTextColor: '#000000',
  pieStrokeColor: '#000000',
  pieOuterStrokeColor: '#9d9d9d',
  cScale0: '#76a9ff',
  cScale1: '#21df9b',
  cScale2: '#ffb734',
  cScale3: '#d492ff',
  cScale4: '#ff8492',
  cScale5: '#ffe066',
  cScale6: '#9bf6ff',
  cScale7: '#ffadad',
  cScale8: '#b3b3ff',
  cScale9: '#7affc4',
  cScale10: '#ffab73',
  // Narrowed against `--card`: 3.09:1 vs card, 5.12:1 vs `cScaleLabel11` (3.08:1 on Obsidian's lighter card).
  cScale11: '#a85400',
  scaleLabelColor: '#000000',
  cScaleLabel11: '#fafafa',
  cScaleInv0: '#9d9d9d',
  cScaleInv1: '#9d9d9d',
  cScaleInv2: '#9d9d9d',
  cScaleInv3: '#9d9d9d',
  cScaleInv4: '#9d9d9d',
  cScaleInv5: '#9d9d9d',
  cScaleInv6: '#9d9d9d',
  cScaleInv7: '#9d9d9d',
  cScaleInv8: '#9d9d9d',
  cScaleInv9: '#9d9d9d',
  cScaleInv10: '#9d9d9d',
  cScaleInv11: '#9d9d9d',
  // Mid-tone, hue-separated fills for journey/gitGraph: each clears 4.5:1 for `textColor` on top and
  // 3:1 vs Obsidian's lighter `--card` (3.24-3.28:1); the two constraints leave no room for more margin.
  fillType0: '#2d71b6',
  fillType1: '#247e51',
  fillType2: '#966420',
  fillType3: '#954bcb',
  fillType4: '#ca3359',
  fillType5: '#816d1b',
  fillType6: '#287989',
  fillType7: '#c73e32',
  // Commit dots stay bright: their label sits in a separate pill coloured by `gitBranchLabel<N>`, not on the fill.
  git0: '#76a9ff',
  git1: '#21df9b',
  git2: '#ffb734',
  git3: '#d492ff',
  git4: '#ff8492',
  git5: '#ffe066',
  git6: '#9bf6ff',
  git7: '#ffadad',
  // Mermaid's light-grey default measured 1.15-1.56:1 on the bright pills; black clears >=8.89:1.
  gitBranchLabel0: '#000000',
  gitBranchLabel1: '#000000',
  gitBranchLabel2: '#000000',
  gitBranchLabel3: '#000000',
  gitBranchLabel4: '#000000',
  gitBranchLabel5: '#000000',
  gitBranchLabel6: '#000000',
  gitBranchLabel7: '#000000'
}

export const MERMAID_THEME_VARIABLES: Record<ThemeId, MermaidThemeVariables> = {
  dark: DARK_FAMILY,
  // Obsidian overrides DARK_FAMILY's surface-tied fields with its own tokens; the palettes are inherited (#550).
  obsidian: {
    ...DARK_FAMILY,
    background: '#0F1014',
    // The real node fill is Mermaid's hardcoded `#1f2020` (13.43:1), not `--card`.
    primaryColor: '#1C1F28',
    primaryTextColor: '#e8e9e9',
    titleColor: '#e8e9e9',
    primaryBorderColor: '#6F7C9D',
    // Muted line/stroke on the page background (7.22:1); `pieOuterStrokeColor` and `cScaleInv*` share it.
    lineColor: '#9f9fa1',
    secondaryColor: '#2A3040',
    tertiaryColor: '#353D4D',
    // General diagram text on the page background (15.39:1); `taskTextOutsideColor` is the same role.
    textColor: '#e7e7e7',
    altSectionBkgColor: '#2A3040',
    sectionBkgColor: '#2A3040',
    sectionBkgColor2: '#2A3040',
    // Note text on `--popover` (0.78 tier, 9.51:1).
    noteBkgColor: '#242834',
    noteTextColor: '#cfd0d2',
    taskTextOutsideColor: '#e7e7e7',
    // Not softened: sits on a coloured task-bar fill (see DARK_FAMILY).
    taskTextClickableColor: '#F8FAFC',
    // Same as `taskTextClickableColor` above: a coloured-fill exception, kept solid.
    taskTextColor: '#F8FAFC',
    // Same muted-foreground override as the high-contrast theme: this preset's softened `--muted-foreground`, not a neutral grey.
    pieOuterStrokeColor: '#9f9fa1',
    cScaleInv0: '#9f9fa1',
    cScaleInv1: '#9f9fa1',
    cScaleInv2: '#9f9fa1',
    cScaleInv3: '#9f9fa1',
    cScaleInv4: '#9f9fa1',
    cScaleInv5: '#9f9fa1',
    cScaleInv6: '#9f9fa1',
    cScaleInv7: '#9f9fa1',
    cScaleInv8: '#9f9fa1',
    cScaleInv9: '#9f9fa1',
    cScaleInv10: '#9f9fa1',
    cScaleInv11: '#9f9fa1',
  },
  'dark-high-contrast': {
    // Uses this theme's real CSS values (`--card` #090909, `--border` #808080, `--muted-foreground` #cecece,
    // `--secondary` #242424) so diagrams match the other panels.
    background: '#000000',
    primaryColor: '#090909',
    primaryTextColor: '#ffffff',
    titleColor: '#ffffff',
    primaryBorderColor: '#808080',
    lineColor: '#cecece',
    // `tertiaryColor` is one step lighter than `--secondary` to keep three-way diagrams distinguishable.
    secondaryColor: '#242424',
    tertiaryColor: '#363636',
    textColor: '#ffffff',
    darkMode: true,
    altSectionBkgColor: '#242424',
    sectionBkgColor: '#242424',
    sectionBkgColor2: '#242424',
    noteBkgColor: '#090909',
    noteTextColor: '#ffffff',
    taskTextDarkColor: '#000000',
    taskTextOutsideColor: '#ffffff',
    taskTextClickableColor: '#ffffff',
    taskTextColor: '#ffffff',
    // Same as `dark`: 5.23:1 vs `taskTextColor`, 3.80:1 vs this theme's darker `--card`.
    critBkgColor: '#db0000',
    // Same palette as `dark`; this theme's `--card` is darker still, so every slot also clears its higher bar.
    pie1: '#76a9ff',
    pie2: '#21df9b',
    pie3: '#ffb734',
    pie4: '#d492ff',
    pie5: '#ff8492',
    pie6: '#ffe066',
    pie7: '#9bf6ff',
    pie8: '#ffadad',
    pie9: '#b3b3ff',
    pie10: '#7affc4',
    pie11: '#ffab73',
    pie12: '#c9ff6b',
    pieOpacity: 1,
    pieSectionTextColor: '#000000',
    pieStrokeColor: '#000000',
    pieOuterStrokeColor: '#cecece',
    cScale0: '#76a9ff',
    cScale1: '#21df9b',
    cScale2: '#ffb734',
    cScale3: '#d492ff',
    cScale4: '#ff8492',
    cScale5: '#ffe066',
    cScale6: '#9bf6ff',
    cScale7: '#ffadad',
    cScale8: '#b3b3ff',
    cScale9: '#7affc4',
    cScale10: '#ffab73',
    // 3.73:1 vs `--card`, 5.34:1 vs `cScaleLabel11`.
    cScale11: '#a85400',
    scaleLabelColor: '#000000',
    cScaleLabel11: '#ffffff',
    cScaleInv0: '#cecece',
    cScaleInv1: '#cecece',
    cScaleInv2: '#cecece',
    cScaleInv3: '#cecece',
    cScaleInv4: '#cecece',
    cScaleInv5: '#cecece',
    cScaleInv6: '#cecece',
    cScaleInv7: '#cecece',
    cScaleInv8: '#cecece',
    cScaleInv9: '#cecece',
    cScaleInv10: '#cecece',
    cScaleInv11: '#cecece',
    // Same mid-tone fills as `dark`; the shared luminance window clears both themes.
    fillType0: '#2d71b6',
    fillType1: '#247e51',
    fillType2: '#966420',
    fillType3: '#954bcb',
    fillType4: '#ca3359',
    fillType5: '#816d1b',
    fillType6: '#287989',
    fillType7: '#c73e32',
    // Same bright palette as `dark` -- see that theme's own comment on this key.
    git0: '#76a9ff',
    git1: '#21df9b',
    git2: '#ffb734',
    git3: '#d492ff',
    git4: '#ff8492',
    git5: '#ffe066',
    git6: '#9bf6ff',
    git7: '#ffadad',
    gitBranchLabel0: '#000000',
    gitBranchLabel1: '#000000',
    gitBranchLabel2: '#000000',
    gitBranchLabel3: '#000000',
    gitBranchLabel4: '#000000',
    gitBranchLabel5: '#000000',
    gitBranchLabel6: '#000000',
    gitBranchLabel7: '#000000'
  },
  // DARK_FAMILY's palettes are inherited (#551); crit/cScale11 clear 3:1 on both new presets' `--card`.
  // `taskTextColor` is unsoftened and live-verified for Journey only; Gantt contrast is unverified (#1108),
  // and `check:mermaid-contrast` is blocked on `require('electron')` (#1106).
  'nordic-frost': {
    ...DARK_FAMILY,
    background: '#060f1e', // `--background`
    primaryColor: '#101b2b', // `--card`
    // 0.9 tier over `--card` (14.13:1); real node fill is Mermaid's hardcoded `#1f2020` (13.32:1).
    primaryTextColor: '#e7e8ea',
    titleColor: '#e7e8ea',
    primaryBorderColor: '#79818c', // `--border`
    // 0.6 tier over `--background` (7.22:1); `pieOuterStrokeColor` and `cScaleInv*` share it.
    lineColor: '#9b9fa5',
    secondaryColor: '#293342', // `--muted`/`--accent`/`--secondary` (`--surface-hover`)
    tertiaryColor: '#34404F', // one step lighter
    // 0.9 tier over `--background` (15.50:1).
    textColor: '#e6e7e8',
    altSectionBkgColor: '#293342',
    sectionBkgColor: '#293342',
    sectionBkgColor2: '#293342',
    noteBkgColor: '#1c2738', // `--popover`
    // 0.78 tier over `--popover` (9.67:1).
    noteTextColor: '#cdcfd3',
    taskTextOutsideColor: '#e6e7e8',
    // Not softened: sits on a coloured task-bar fill.
    taskTextClickableColor: '#eff7fb',
    taskTextColor: '#eff7fb',
    // This preset's softened `--muted-foreground`, same as `lineColor`.
    pieOuterStrokeColor: '#9b9fa5',
    cScaleInv0: '#9b9fa5',
    cScaleInv1: '#9b9fa5',
    cScaleInv2: '#9b9fa5',
    cScaleInv3: '#9b9fa5',
    cScaleInv4: '#9b9fa5',
    cScaleInv5: '#9b9fa5',
    cScaleInv6: '#9b9fa5',
    cScaleInv7: '#9b9fa5',
    cScaleInv8: '#9b9fa5',
    cScaleInv9: '#9b9fa5',
    cScaleInv10: '#9b9fa5',
    cScaleInv11: '#9b9fa5'
  },
  // Cyber Amber's surfaces, text and border match Default Dark, so it reuses `DARK_FAMILY` directly
  // rather than a copy that could drift (#1039).
  'cyber-amber': DARK_FAMILY
}
