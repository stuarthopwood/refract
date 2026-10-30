import type { ThemeId } from './themes'

// Overrides layered on Mermaid's built-in 'dark' theme; values are tuned for WCAG contrast
// (checked by scripts/check-mermaid-contrast.mjs), so change them only with that script.
/** Mermaid `themeVariables` overrides for one app theme. */
export interface MermaidThemeVariables {
 /** Canvas background; matches the theme's own `--background`. */
 background: string
 /** Node fill colour; matches the theme's own `--card`. */
 primaryColor: string
 /** Node label text colour; matches the theme's own `--card-foreground`. */
 primaryTextColor: string
 primaryBorderColor: string
 /** Edge/connector line colour; matches the theme's own `--muted-foreground`. */
 lineColor: string
 secondaryColor: string
 tertiaryColor: string
 /** General text colour (titles, notes); matches the theme's own `--foreground`. */
 textColor: string
 darkMode: true
 altSectionBkgColor: string
 sectionBkgColor: string
 sectionBkgColor2: string
 /** Note shape fill; matches the theme's own `--popover`. */
 noteBkgColor: string
 /** Note shape text colour; matches the theme's own `--popover-foreground`. */
 noteTextColor: string
 taskTextDarkColor: string
 taskTextOutsideColor: string
 taskTextClickableColor: string
 taskTextColor: string
 critBkgColor: string
 pie1: string
 pie2: string
 pie3: string
 pie4: string
 pie5: string
 pie6: string
 pie7: string
 pie8: string
 pie9: string
 pie10: string
 pie11: string
 pie12: string
 pieOpacity: number
 pieSectionTextColor: string
 pieStrokeColor: string
 pieOuterStrokeColor: string
 cScale0: string
 cScale1: string
 cScale2: string
 cScale3: string
 cScale4: string
 cScale5: string
 cScale6: string
 cScale7: string
 cScale8: string
 cScale9: string
 cScale10: string
 cScale11: string
 scaleLabelColor: string
 cScaleLabel11: string
 cScaleInv0: string
 cScaleInv1: string
 cScaleInv2: string
 cScaleInv3: string
 cScaleInv4: string
 cScaleInv5: string
 cScaleInv6: string
 cScaleInv7: string
 cScaleInv8: string
 cScaleInv9: string
 cScaleInv10: string
 cScaleInv11: string
 fillType0: string
 fillType1: string
 fillType2: string
 fillType3: string
 fillType4: string
 fillType5: string
 fillType6: string
 fillType7: string
 git0: string
 git1: string
 git2: string
 git3: string
 git4: string
 git5: string
 git6: string
 git7: string
 gitBranchLabel0: string
 gitBranchLabel1: string
 gitBranchLabel2: string
 gitBranchLabel3: string
 gitBranchLabel4: string
 gitBranchLabel5: string
 gitBranchLabel6: string
 gitBranchLabel7: string
 titleColor: string
}

export { MERMAID_THEME_VARIABLES } from './mermaidThemeData'
import { MERMAID_THEME_VARIABLES } from './mermaidThemeData'
import { MERMAID_ACCENTS } from './mermaidAccent'

/** Extra CSS for Mermaid's `themeCSS` option; beats Mermaid's own `!important` rules by selector specificity. */
export function getMermaidThemeCSS(themeId: ThemeId): string {
 const t = MERMAID_THEME_VARIABLES[themeId]
 const { accent, fill } = MERMAID_ACCENTS[themeId]
 const overflowStates = ['activeText', 'activeCritText']
 const overflowSelectors = overflowStates
  .flatMap((state) => [0, 1, 2, 3].map((n) => `${state}${n}`))
  .flatMap((cls) => [`.${cls}.taskTextOutsideLeft`, `.${cls}.taskTextOutsideRight`])
  .join(',\n  ')
 const clickableSelectors = ['doneText', 'activeText', 'activeCritText']
  .flatMap((state) => [0, 1, 2, 3].map((n) => `.taskText.clickable.${state}${n}`))
  .join(',\n  ')
 return `
  ${overflowSelectors} {
    fill: ${t.taskTextOutsideColor} !important;
  }
  ${clickableSelectors} {
    fill: ${t.taskTextDarkColor} !important;
  }
  .eventWrapper {
    filter: none !important;
  }
  /* #456 accent: flowchart nodes (id contains -flowchart-), cluster borders, edge lines, arrowheads. Fill has no !important so author colours win. */
  .node[id*="-flowchart-"] rect, .node[id*="-flowchart-"] polygon, .node[id*="-flowchart-"] circle, .node[id*="-flowchart-"] ellipse, .node[id*="-flowchart-"] path {
    stroke: ${accent};
    fill: ${fill};
  }
  .cluster rect {
    stroke: ${accent};
  }
  .flowchart-link {
    stroke: ${accent};
  }
  .arrowMarkerPath {
    fill: ${accent};
    stroke: ${accent};
  }
  /* Quality-gate remediation (round 6): gitGraph's own \`.commit-label-bkg\` rect ships at
     \`opacity: 0.5\`, so wherever a commit sits on a bright \`git<N>\` branch line, the line shows
     through the label's own background at 50% strength and the default commit-label text colour
     (#b8b6b6) can measure as low as 1.4-2.0:1 against that blend (real screenshot-pixel
     measurement, not CSS reading -- see scripts/check-mermaid-contrast.mjs's own
     measureTextFromScreenshots). Forcing the label background fully opaque removes the blend
     entirely: measured ~7.6:1 (text #b8b6b6 on the now-opaque #2b2b2b label background)
     afterward, verified live via the same real-pixel harness. */
  .commit-label-bkg {
    opacity: 1 !important;
  }
  .task ~ switch .label,
  .journey-section ~ switch .label {
    color: ${t.taskTextColor} !important;
  }
`
}
