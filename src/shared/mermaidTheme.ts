// Mermaid `themeVariables` built from the `--mermaid-*` theme tokens (spec 084). The shipped values
// are contrast-tuned (scripts/check-mermaid-contrast.mjs), so change token values only with that script.
/** Mermaid `themeVariables`: colour strings plus the two constants. */
export type MermaidThemeVariables = Record<string, string | number | boolean>

/** Reads one `--mermaid-<name>` token as a `#rrggbb` string. */
export type MermaidTokenReader = (name: string) => string

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

/** `darkMode` is false for the light presets (#1590) so Mermaid derives its own tints from a light base. */
export function buildMermaidThemeVariables(read: MermaidTokenReader, darkMode = true): MermaidThemeVariables {
  const palette = range(12).map((i) => read(`palette-${i + 1}`))
  const ink = read('ink')
  const line = read('line')
  const secondary = read('secondary')
  const taskText = read('task-text')
  const v: MermaidThemeVariables = {
    background: read('bg'),
    primaryColor: read('node-fill'),
    primaryTextColor: read('node-fg'),
    titleColor: read('node-fg'),
    primaryBorderColor: read('border'),
    lineColor: line,
    secondaryColor: secondary,
    tertiaryColor: read('tertiary'),
    textColor: read('text'),
    darkMode,
    altSectionBkgColor: secondary,
    sectionBkgColor: secondary,
    sectionBkgColor2: secondary,
    noteBkgColor: read('note-bg'),
    noteTextColor: read('note-fg'),
    taskTextDarkColor: ink,
    taskTextOutsideColor: read('text'),
    taskTextClickableColor: taskText,
    taskTextColor: taskText,
    critBkgColor: read('crit'),
    pieOpacity: 1,
    pieSectionTextColor: ink,
    pieStrokeColor: ink,
    pieOuterStrokeColor: line,
    scaleLabelColor: ink,
    cScale11: read('cscale-11'),
    cScaleLabel11: read('cscale-label-11')
  }
  palette.forEach((c, i) => {
    v[`pie${i + 1}`] = c
  })
  range(11).forEach((i) => {
    v[`cScale${i}`] = palette[i] ?? ''
  })
  range(12).forEach((i) => {
    v[`cScaleInv${i}`] = line
  })
  range(8).forEach((i) => {
    v[`fillType${i}`] = read(`fill-${i + 1}`)
    v[`git${i}`] = palette[i] ?? ''
    v[`gitBranchLabel${i}`] = ink
  })
  return v
}

/** Extra CSS for Mermaid's `themeCSS` option; beats Mermaid's own `!important` rules by selector specificity. */
export function getMermaidThemeCSS(read: MermaidTokenReader): string {
  const accent = read('accent')
  const fill = read('accent-fill')
  const overflowSelectors = ['activeText', 'activeCritText']
    .flatMap((state) => [0, 1, 2, 3].map((n) => `${state}${n}`))
    .flatMap((cls) => [`.${cls}.taskTextOutsideLeft`, `.${cls}.taskTextOutsideRight`])
    .join(',\n  ')
  const clickableSelectors = ['doneText', 'activeText', 'activeCritText']
    .flatMap((state) => [0, 1, 2, 3].map((n) => `.taskText.clickable.${state}${n}`))
    .join(',\n  ')
  return `
  ${overflowSelectors} {
    fill: ${read('text')} !important;
  }
  ${clickableSelectors} {
    fill: ${read('ink')} !important;
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
  /* gitGraph's commit-label rect ships at opacity 0.5, so a bright branch line shows through and drops label contrast below 2:1. */
  .commit-label-bkg {
    opacity: 1 !important;
  }
  .task ~ switch .label,
  .journey-section ~ switch .label {
    color: ${read('task-text')} !important;
  }
`
}
