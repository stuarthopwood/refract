// Token pairs rendered by this codebase, imported by check-theme-contrast.mjs (split out for the file-size ratchet).
// The composited checks below share contrast-math.mjs's blend primitives; a private copy once drifted to a wrong blend.
// `min: 4.5` = WCAG AA body/UI text; `min: 3` = large text and non-text UI (rings, control edges, icons).
// `--divider` is a decorative edge, not a control edge; `--border` is a control edge in every theme.
// `onlyThemes` restricts a pair to the named themes; `informationalThemes` also restricts, but the ratio is printed
// and never counted as a failure (accepted departure, docs/design/accessibility.md).

import { clamp01, compositeOverLinear, contrastRatio, linearToHex, relativeLuminance, resolvedLinear, srgbGammaDecode, srgbGammaEncode } from './contrast-math.mjs'
import { createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { HIGH_CONTRAST_THEMES, STANDARD_THEMES } from './theme-groups.mjs'

export const PAIRS = [
  // #887: the ten Project colour presets on the Session list background.
  ...Array.from({ length: 10 }, (_, i) => ({ fg: `project-${i + 1}`, bg: 'sidebar', min: 4.5 })),
  ...Array.from({ length: 10 }, (_, i) => ({ fg: `project-${i + 1}`, bg: 'sidebar-accent', min: 4.5 })),
  { fg: 'active-indicator', bg: 'sidebar-right', min: 3 }, // #1126: the pressed IconRail's ActiveIndicatorBar (non-colour cue; its muted fill alone is only ~1.3:1 against the rail)
  { fg: 'foreground', bg: 'sidebar-right', min: 4.5 }, { fg: 'muted-foreground', bg: 'sidebar-right', min: 4.5 }, { fg: 'accent-text', bg: 'sidebar-right', min: 4.5 }, // #674: the right pane and rail surface
  { fg: 'foreground', bg: 'background', min: 4.5 },
  { fg: 'card-foreground', bg: 'card', min: 4.5 },
  { fg: 'popover-foreground', bg: 'popover', min: 4.5 },
  { fg: 'primary-foreground', bg: 'primary', min: 4.5 },
  { fg: 'send-foreground', bg: 'send', min: 3 },
  { fg: 'foreground', bg: 'viewer-tint', min: 4.5 }, { fg: 'muted-foreground', bg: 'viewer-tint', min: 4.5 }, // spec 038: the viewer's own PR card header text
  { fg: 'agent-message', bg: 'background', min: 4.5 }, { fg: 'agent-message', bg: 'muted', min: 4.5 }, // #838: AgentMessageRow glyph + label, at rest and on the trigger's hover:bg-muted
  { fg: 'send', bg: 'background', min: 3, onlyThemes: STANDARD_THEMES },
  // `--composer-background` is transparent except in Dark high contrast, so Send is measured against `--background` elsewhere (#927, #551).
  { fg: 'send', bg: 'composer-background', min: 3, onlyThemes: HIGH_CONTRAST_THEMES },
  // Hint text sits on `--composer-background` (own per-theme fill), unlike the page `--background`.
  { fg: 'muted-foreground', bg: 'composer-background', min: 4.5, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'composer-focus', bg: 'composer-background', min: 3, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'composer-control-border', bg: 'composer-background', min: 3, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'secondary-foreground', bg: 'secondary', min: 4.5 },
  { fg: 'muted-foreground', bg: 'background', min: 4.5 },
  { fg: 'accent-foreground', bg: 'accent', min: 4.5 },
  { fg: 'destructive-foreground', bg: 'destructive', min: 4.5 },
  { fg: 'chat-foreground', bg: 'background', min: 4.5 },
  { fg: 'state-working-foreground', bg: 'state-working', min: 4.5 },
  { fg: 'state-needs-you-foreground', bg: 'state-needs-you', min: 4.5 },
  { fg: 'state-stopped-foreground', bg: 'state-stopped', min: 4.5 },
  { fg: 'ring', bg: 'background', min: 3 },
  { fg: 'scrollbar-thumb', bg: 'background', min: 3 },
  { fg: 'active-indicator', bg: 'background', min: 3 },
  // dropdown-menu.tsx's active-row inset shadow renders this token on bg-popover.
  { fg: 'active-indicator', bg: 'popover', min: 3 },
  // #1950: the item type icon (`text-pr-open` / `text-pr-merged`, non-text) in the hover card (`--popover`); the user bubble is in userBubbleContrastRows.
  { fg: 'pr-open', bg: 'popover', min: 3 },
  { fg: 'pr-merged', bg: 'popover', min: 3 },
  { fg: 'active-indicator', bg: 'accent', min: 3 }, // #1122: ActiveIndicatorBar now also sits on bg-accent
  { fg: 'active-indicator', bg: 'muted', min: 3 }, // #1122: SubagentPanel.tsx's `hover:bg-muted/50` row hover can paint under a selected row's bar
  { fg: 'ring', bg: 'accent', min: 3 }, // #1122: focus-visible:ring-ring now paints while focused on an accent-filled selected row
  { fg: 'severity-success', bg: 'accent', min: 3 },
  { fg: 'severity-error', bg: 'accent', min: 3 },
  { fg: 'destructive', bg: 'accent', min: 4.5 }, // #1122: ManageSessionRow.tsx's "Worktree missing" body text on the selected row's bg-accent
  { fg: 'state-idle', bg: 'accent', min: 3 },
  { fg: 'state-needs-you', bg: 'accent', min: 3 },
  { fg: 'state-stopped', bg: 'accent', min: 3 },
  { fg: 'state-working', bg: 'accent', min: 4.5 }, // #1122/#700: real body text ("In progress") on the new accent-filled selected row
  { fg: 'destructive', bg: 'background', min: 3 },
  { fg: 'state-working', bg: 'background', min: 4.5 }, // #700: also real BODY TEXT ("In progress"), not just icon-only -- 4.5 subsumes the old 3:1 icon floor
  { fg: 'state-idle', bg: 'background', min: 3 },
  { fg: 'state-needs-you', bg: 'background', min: 3 },
  { fg: 'state-stopped', bg: 'background', min: 3 },
  // The shared `StateIcon` renders on the session row (sidebar/sidebar-accent), chat header (background) and hover card (popover) (#731).
  { fg: 'state-idle', bg: 'sidebar', min: 3 },
  { fg: 'state-idle', bg: 'sidebar-accent', min: 3 },
  { fg: 'state-idle', bg: 'popover', min: 3 },
  { fg: 'state-unread-response', bg: 'sidebar', min: 3 },
  { fg: 'state-unread-response', bg: 'sidebar-accent', min: 3 },
  { fg: 'state-unread-response', bg: 'background', min: 3 },
  { fg: 'state-unread-response', bg: 'popover', min: 3 },
  // `--input` is the border of every Input/Textarea/Select/outline control.
  { fg: 'input', bg: 'background', min: 3 },
  // Control-edge tokens (`--border-strong` aliases `--border`); the 'token missing' path fires if a theme omits one.
  { fg: 'border', bg: 'background', min: 3 },
  { fg: 'border', bg: 'card', min: 3 },
  { fg: 'border', bg: 'popover', min: 3 },
  { fg: 'border', bg: 'muted', min: 3 },
  // The radio dot/checked ring (`border-foreground`, not `border-primary`: --primary/--popover is under 3:1 in
  // Obsidian and Nordic Frost) sits on bg-popover; a focused checked row sits on --accent instead (#1043).
  { fg: 'foreground', bg: 'popover', min: 3 },
  { fg: 'foreground', bg: 'accent', min: 4.5 }, // #1122: PR/Manage sessions/Subagent rows' unstyled title span, real body text
  { fg: 'border-strong', bg: 'background', min: 3 },
  { fg: 'border-strong', bg: 'card', min: 3 },
  { fg: 'border-strong', bg: 'popover', min: 3 },
  { fg: 'border-strong', bg: 'muted', min: 3 },
  { fg: 'accent-text', bg: 'background', min: 4.5 },
  { fg: 'accent-text', bg: 'card', min: 4.5 },
  { fg: 'accent-text', bg: 'popover', min: 4.5 },
  { fg: 'accent-text', bg: 'muted', min: 3 }, // #1125, #1126: also the pressed IconRail glyph on its bg-muted fill
  { fg: 'accent-text', bg: 'surface-hover', min: 4.5 }, // #1873: the "+N" label chip on a hovered issue row
  { fg: 'accent-text', bg: 'accent', min: 4.5 }, // #1873: the same chip on the selected issue row
  // The four role colours, as swatches beside the role names in Models (spec 036).
  ...['default', 'smol', 'slow', 'plan'].flatMap((role) => ['background', 'card', 'popover', 'accent'].map((bg) => ({ fg: `role-${role}`, bg, min: 3 }))),
  { fg: 'severity-success', bg: 'background', min: 3 },
  { fg: 'severity-success', bg: 'card', min: 3 },
  { fg: 'severity-success', bg: 'popover', min: 3 },
  { fg: 'severity-warning', bg: 'background', min: 3 },
  { fg: 'severity-warning', bg: 'card', min: 3 },
  { fg: 'severity-warning', bg: 'popover', min: 3 },
  { fg: 'severity-error', bg: 'background', min: 3 },
  { fg: 'severity-error', bg: 'card', min: 3 },
  { fg: 'severity-error', bg: 'popover', min: 3 },
  { fg: 'severity-info', bg: 'background', min: 3 },
  { fg: 'severity-info', bg: 'card', min: 3 },
  { fg: 'severity-info', bg: 'popover', min: 3 },
  // GitHub alert bars and icons (non-text, 3:1) on the chat and card surfaces.
  ...['note', 'tip', 'important', 'warning', 'caution'].flatMap((kind) => [
    { fg: `alert-${kind}`, bg: 'background', min: 3 },
    { fg: `alert-${kind}`, bg: 'card', min: 3 }
  ]),
  // `muted-foreground` and `destructive` render as body text on the muted/accent fills and card/popover surfaces too.
  { fg: 'muted-foreground', bg: 'muted', min: 4.5 },
  { fg: 'muted-foreground', bg: 'accent', min: 4.5 },
  { fg: 'muted-foreground', bg: 'card', min: 4.5 },
  // #1728: body text on the Subagents chain / Ask card fill (`--chat-card-bg`, `--card` at 60% over the page). The card edge and fill step are an accepted
  // departure below 3:1 in non-high-contrast themes (docs/design/accessibility.md); floors are the measured ratios, so they can't regress.
  { fg: 'muted-foreground', bg: 'chat-card-bg', on: 'background', min: 4.5 },
  { fg: 'foreground', bg: 'chat-card-bg', on: 'background', min: 4.5 },
  { fg: 'divider', bg: 'chat-card-bg', on: 'background', min: 1.39 },
  { fg: 'divider', bg: 'chat-card-bg', on: 'background', min: 3, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'chat-card-bg', bg: 'background', min: 1.04 },
  // Chrome band (#682): text and icons on the shared `--titlebar` surface.
  { fg: 'foreground', bg: 'titlebar', min: 4.5 },
  { fg: 'muted-foreground', bg: 'titlebar', min: 4.5 },
  { fg: 'muted-foreground', bg: 'popover', min: 4.5 },
  { fg: 'muted-foreground', bg: 'surface-hover', min: 4.5 },
  { fg: 'chat-foreground', bg: 'accent', min: 4.5 }, // #1119: Explorer name span vs its own aria-selected:bg-accent fill
  // Added-line count is real `text-xs` body text on the diff box's `bg-muted` header.
  { fg: 'state-working', bg: 'muted', min: 4.5 },
  // Subagent status icons on `--muted` (#563 remediation, decision 26): finished/failed icons.
  { fg: 'state-idle', bg: 'muted', min: 3 },
  { fg: 'severity-error', bg: 'muted', min: 3 },
  // Node icons and notice summary text must keep their floor on `CollapsedLine`'s `hover:bg-muted` tint.
  { fg: 'destructive', bg: 'muted', min: 4.5 },
  { fg: 'state-needs-you', bg: 'muted', min: 4.5 },
  // `severity-error` renders as text (never `text-destructive`) on the row and hover tint. It aliases `destructive`
  // today; gate the token actually rendered so a later split is noticed.
  { fg: 'severity-error', bg: 'background', min: 4.5 },
  { fg: 'severity-error', bg: 'muted', min: 4.5 },
  // A finished agent/Stage name renders `text-severity-success` as text, same precedent as `severity-error` above.
  { fg: 'severity-success', bg: 'background', min: 4.5 },
  { fg: 'severity-success', bg: 'muted', min: 4.5 },
  // Dark (high contrast) targets 7:1 text; `--muted` is its lightest surface, so the binding case (docs/design/accessibility.md).
  { fg: 'severity-error', bg: 'muted', min: 7, onlyThemes: HIGH_CONTRAST_THEMES },
  // Warning and success summaries render real body text in the same role.
  { fg: 'severity-warning', bg: 'muted', min: 7, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'severity-success', bg: 'muted', min: 7, onlyThemes: HIGH_CONTRAST_THEMES },
  // `severity-warning` text passes only via its alias of `state-needs-you`; gate the rendered token.
  { fg: 'severity-warning', bg: 'background', min: 4.5 },
  { fg: 'severity-warning', bg: 'muted', min: 4.5 },
  { fg: 'destructive', bg: 'card', min: 4.5 },
  { fg: 'destructive', bg: 'popover', min: 4.5 },
  // `CheckRow` hint text sits directly on `--background`, so both need a real 4.5:1 text pair there.
  { fg: 'destructive', bg: 'background', min: 4.5 },
  { fg: 'state-needs-you', bg: 'background', min: 4.5 },
  // `--composer-placeholder` (~40% white) on `--background` is an accepted departure: below 4.5:1 text, above 3:1
  // non-text (docs/design/accessibility.md "Accepted departures"). Dark high contrast keeps `--muted-foreground`.
  { fg: 'composer-placeholder', bg: 'background', min: 3.5, onlyThemes: STANDARD_THEMES },
  // Dialogs and menus sit on `--popover`/`--muted`, not the page, so control edges and rings are checked there too.
  { fg: 'input', bg: 'popover', min: 3 },
  { fg: 'input', bg: 'muted', min: 3 },
  { fg: 'ring', bg: 'popover', min: 3 },
  { fg: 'ring', bg: 'muted', min: 3 },
  // `CodeBlock`'s scrollable body (focus ring) sits directly on `--card`.
  { fg: 'ring', bg: 'card', min: 3 },
  // Ghost composer triggers focus with `--composer-focus` (not `--ring`, so check the token actually rendered).
  // Enforced only in Dark high contrast; Dark/Obsidian/Nordic Frost/Cyber Amber are an accepted WCAG 1.4.11
  // departure (docs/design/accessibility.md), surfaced as informational pairs against `--background` below.
  { fg: 'composer-border', bg: 'background', min: 3, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'composer-border', bg: 'background', min: 3, informationalThemes: STANDARD_THEMES },
  { fg: 'composer-focus', bg: 'background', min: 3, informationalThemes: STANDARD_THEMES },
  // The agent-working spinner renders on the session list, that row selected/hovered (icon is the only status cue),
  // the chat header, and the hover card (`--popover`). `--card` is kept as a cheap fourth check.
  { fg: 'agent-spinner-core', bg: 'sidebar', min: 3 },
  { fg: 'agent-spinner-core', bg: 'sidebar-accent', min: 3 },
  { fg: 'agent-spinner-core', bg: 'card', min: 3 },
  { fg: 'agent-spinner-core', bg: 'popover', min: 3 },
  { fg: 'agent-spinner-core', bg: 'background', min: 3 },
  // The Waiting marker, the visible Session's active bar and the toolbar buttons' focus ring render on `--sidebar`.
  { fg: 'state-needs-you', bg: 'sidebar', min: 3 },
  { fg: 'state-needs-you', bg: 'sidebar-accent', min: 3 },
  { fg: 'state-stopped', bg: 'sidebar', min: 3 },
  { fg: 'state-stopped', bg: 'sidebar-accent', min: 3 },
  // `state-stopped` copies `--destructive` here; `--sidebar-accent` is the selected/hovered row it renders on.
  { fg: 'state-stopped', bg: 'sidebar-accent', min: 7, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'active-indicator', bg: 'sidebar', min: 3 },
  { fg: 'active-indicator', bg: 'sidebar-accent', min: 3 },
  { fg: 'ring', bg: 'sidebar', min: 3 },
  { fg: 'ring', bg: 'sidebar-accent', min: 3 },
  // Toolbar ghost buttons default to `text-muted-foreground` (real text), so the 4.5:1 floor applies.
  { fg: 'muted-foreground', bg: 'sidebar', min: 4.5 },
  { fg: 'muted-foreground', bg: 'sidebar-accent', min: 4.5 },
  { fg: 'sidebar-foreground', bg: 'sidebar', min: 4.5 },
  { fg: 'sidebar-foreground', bg: 'sidebar-accent', min: 4.5 },
  { fg: 'destructive', bg: 'sidebar', min: 4.5 },
  { fg: 'destructive', bg: 'sidebar-accent', min: 4.5 },
  { fg: 'state-working', bg: 'sidebar', min: 3 },
  { fg: 'state-working', bg: 'sidebar-accent', min: 3 },
  { fg: 'severity-info', bg: 'sidebar', min: 3 },
  { fg: 'severity-info', bg: 'sidebar-accent', min: 3 },
  // #768 Git decoration: file-explorer names and icons are body text on the pane surface, the hover row and the selected row (`--accent`).
  ...['modified', 'added', 'untracked', 'deleted', 'ignored', 'renamed', 'conflicted', 'staged'].flatMap((mark) =>
    ['background', 'sidebar', 'sidebar-right', 'sidebar-accent', 'accent'].map((bg) => ({ fg: `git-${mark}`, bg, min: 4.5 }))
  ),
  // The pull request StatePill: its text against its own fill. `pr-open`/`pr-closed` alias gated fills, but the
  // token actually rendered is gated too.
  { fg: 'pr-open-foreground', bg: 'pr-open', min: 4.5 },
  { fg: 'pr-draft-foreground', bg: 'pr-draft', min: 4.5 },
  { fg: 'pr-closed-foreground', bg: 'pr-closed', min: 4.5 },
  // `pr-closed` copies `--destructive` here; `--muted` is the PR list/detail hover tint (binding surface).
  { fg: 'pr-closed', bg: 'muted', min: 7, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'pr-merged-foreground', bg: 'pr-merged', min: 4.5 },
  // Diff-stat "+A -D" is body text (4.5:1). `diff-added`/`diff-removed` alias other tokens, but the token rendered is gated.
  // The status line sits outside the composer fill, so it is on `--background` in every theme (no onlyThemes split).
  // Hover card is `--popover`; per-file and transcript diff headers are `--muted`.
  { fg: 'diff-added', bg: 'background', min: 4.5 },
  { fg: 'diff-removed', bg: 'background', min: 4.5 },
  { fg: 'diff-added', bg: 'popover', min: 4.5 },
  { fg: 'diff-removed', bg: 'popover', min: 4.5 },
  { fg: 'diff-added', bg: 'muted', min: 4.5 },
  { fg: 'diff-removed', bg: 'muted', min: 4.5 },
  { fg: 'border', bg: 'sidebar', min: 3 }, // #738 resize grip (bg-border) beside the session list
  { fg: 'border', bg: 'titlebar', min: 3 }, // resize grip rests on the titlebar-adjacent chrome
  { fg: 'accent-text', bg: 'sidebar', min: 3 }, // grip focus/drag beside the session list
  // #1472 per-element tokens: one pair per fg/bg token on its real surface.
  { fg: 'tool-row-fg', bg: 'background', min: 4.5 },
  { fg: 'tool-row-fg', bg: 'md-code-bg', min: 4.5 },
  { fg: 'tool-row-error-fg', bg: 'background', min: 4.5 },
  { fg: 'thinking-row-fg', bg: 'background', min: 4.5 },
  { fg: 'thinking-row-active-fg', bg: 'background', min: 4.5 },
  { fg: 'notice-info-fg', bg: 'background', min: 4.5 },
  { fg: 'notice-warning-fg', bg: 'background', min: 4.5 },
  { fg: 'notice-error-fg', bg: 'background', min: 4.5 },
  { fg: 'approval-card-fg', bg: 'approval-card-bg', min: 4.5 },
  { fg: 'composer-control-fg', bg: 'background', min: 4.5 },
  { fg: 'composer-control-hover-fg', bg: 'composer-control-hover-bg', min: 4.5 },
  { fg: 'composer-control-open-fg', bg: 'composer-control-open-bg', min: 4.5 },
  { fg: 'button-secondary-fg', bg: 'button-secondary-bg', min: 4.5 },
  { fg: 'button-destructive-fg', bg: 'button-destructive-bg', min: 4.5 },
  { fg: 'button-outline-border', bg: 'background', min: 3 },
  { fg: 'button-outline-fg', bg: 'background', min: 4.5 },
  // Translucent fills are measured over the surface they paint on (`on`). `approval-card-border` and the attention pill border are decorative edges like `--divider`, so unpaired.
  { fg: 'button-secondary-fg', bg: 'button-secondary-hover-bg', on: 'background', min: 4.5 },
  { fg: 'button-destructive-fg', bg: 'button-destructive-hover-bg', on: 'background', min: 4.5, onlyThemes: [...STANDARD_THEMES.filter((id) => id !== 'cyber-amber'), ...HIGH_CONTRAST_THEMES] },
  // cyber-amber's hover reads 4.26:1; built-in colours stay unchanged, so the gap is recorded, not enforced (#1485).
  { fg: 'button-destructive-fg', bg: 'button-destructive-hover-bg', on: 'background', min: 4.5, informationalThemes: ['cyber-amber'] },
  { fg: 'button-outline-fg', bg: 'button-outline-bg', on: 'background', min: 4.5 },
  { fg: 'button-outline-fg', bg: 'button-outline-hover-bg', on: 'background', min: 4.5 },
  { fg: 'tooltip-border', bg: 'tooltip-bg', min: 3 },
  // Mermaid labels (#1491): the HC row keeps its stricter 7:1; the flowchart node uses its accent fill, covered by mermaidAccentRows.
  { fg: 'mermaid-text', bg: 'mermaid-bg', min: 4.5 },
  { fg: 'mermaid-text', bg: 'mermaid-bg', min: 7, onlyThemes: HIGH_CONTRAST_THEMES },
  { fg: 'mermaid-node-fg', bg: 'mermaid-node-fill', min: 4.5 },
  { fg: 'mermaid-cscale-label-11', bg: 'mermaid-cscale-11', min: 4.5 },
  { fg: 'status-bar-fg', bg: 'status-bar-bg', min: 4.5 },
  { fg: 'status-pill-attention-fg', bg: 'status-bar-bg', min: 4.5 },
  { fg: 'status-pill-attention-fg', bg: 'status-pill-attention-bg', on: 'status-bar-bg', min: 4.5 },
  { fg: 'status-pill-attention-fg', bg: 'status-pill-attention-hover-bg', on: 'status-bar-bg', min: 4.5 },
  { fg: 'tooltip-fg', bg: 'tooltip-bg', min: 4.5 },
  { fg: 'session-row-fg', bg: 'session-row-selected-bg', min: 4.5 },
  { fg: 'session-row-meta-fg', bg: 'session-row-selected-bg', min: 4.5 },
  { fg: 'session-row-fg', bg: 'sidebar', min: 4.5 },
  { fg: 'session-row-meta-fg', bg: 'sidebar', min: 4.5 },
  { fg: 'session-row-fg', bg: 'session-row-hover-bg', min: 4.5 },
  { fg: 'session-row-meta-fg', bg: 'session-row-hover-bg', min: 4.5 },
  { fg: 'session-row-selected-fg', bg: 'session-row-selected-bg', min: 4.5 },
]

// The search field's `bg-input/30` fill always renders (`.dark` is always on `<html>`), and `--input` is itself
// translucent, so it composites at `input.alpha * 0.3` over `--sidebar`. That needs alpha math, not a PAIRS entry.
export function searchFieldContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const input = props['input']
    const sidebar = props['sidebar']
    const mutedForeground = props['muted-foreground']
    if (!input || !sidebar || !mutedForeground) {
      rows.push({ themeId, fg: 'muted-foreground', bg: 'search-field (input*0.3 on sidebar)', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const fieldLinear = resolvedLinear({ raw: 'input*0.3', alpha: input.alpha * 0.3, linear: input.linear }, sidebar)
    // `muted-foreground` is translucent: composite it over the real field backdrop, don't score it as opaque.
    const fgLinear = resolvedLinear(mutedForeground, { raw: 'search-field', alpha: 1, linear: fieldLinear })
    const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(fieldLinear))
    rows.push({
      themeId,
      fg: 'muted-foreground',
      bg: 'search-field (input*0.3 on sidebar)',
      min: 4.5,
      ratio,
      pass: ratio >= 4.5,
      fgHex: linearToHex(fgLinear),
      bgHex: linearToHex(fieldLinear),
    })
  }
  return rows
}

// Links and chat prose composite over the user bubble's translucent fill (`--chat-user-bubble-bg`, muted at 50%), and `--chat-foreground`
// is itself translucent, so it composites twice. Blend the bubble over `--background`, then each foreground over that.
export function userBubbleContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const muted = props['muted']
    const background = props['background']
    const accentText = props['accent-text']
    const chatForeground = props['chat-foreground']
    if (!muted || !background || !accentText || !chatForeground) {
      rows.push({ themeId, fg: 'accent-text/chat-foreground', bg: 'user-bubble (muted/50 on background)', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const bubble = { raw: 'bubble', alpha: 1, linear: resolvedLinear({ raw: 'muted/50', alpha: 0.5, linear: muted.linear }, background) }
    const bubbleLum = relativeLuminance(bubble.linear)
    for (const [fg, entry, min] of [['accent-text', accentText, 4.5], ['chat-foreground', chatForeground, 4.5], ['pr-open', props['pr-open'], 3], ['pr-merged', props['pr-merged'], 3]]) {
      if (!entry) {
        rows.push({ themeId, fg, bg: 'user-bubble (muted/50 on background)', min, ratio: null, pass: false, note: 'token missing' })
        continue
      }
      const fgLinear = resolvedLinear(entry, bubble)
      const ratio = contrastRatio(relativeLuminance(fgLinear), bubbleLum)
      rows.push({ themeId, fg, bg: 'user-bubble (muted/50 on background)', min, ratio, pass: ratio >= min, fgHex: linearToHex(fgLinear), bgHex: linearToHex(bubble.linear) })
    }
  }
  return rows
}

// `--sidebar-border` is a real hover/expanded fill (`hover:bg-sidebar-border`) in every theme, but the alias check in
// check-theme-contrast.mjs only covers presets where it aliases `--divider`. Informational only: Dark high contrast
// measures ~2.50:1, a known gap tracked on #552 (others clear 4.5:1 with real alpha composited).
export function sidebarBorderContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const sidebarBorder = props['sidebar-border']
    const sidebar = props['sidebar']
    const mutedForeground = props['muted-foreground']
    if (!sidebarBorder || !sidebar || !mutedForeground) {
      rows.push({ themeId, fg: 'muted-foreground', bg: 'sidebar-border-hover (sidebar-border on sidebar)', min: 4.5, ratio: null, pass: true, note: 'token missing, informational only -- not enforced (#551)' })
      continue
    }
    const fillLinear = resolvedLinear(sidebarBorder, sidebar)
    // Same translucent-as-solid trap as above.
    const fgLinear = resolvedLinear(mutedForeground, { raw: 'sidebar-border-hover', alpha: 1, linear: fillLinear })
    const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(fillLinear))
    rows.push({
      themeId,
      fg: 'muted-foreground',
      bg: 'sidebar-border-hover (sidebar-border on sidebar)',
      min: 4.5,
      ratio,
      pass: true,
      fgHex: linearToHex(fgLinear),
      bgHex: linearToHex(fillLinear),
      note: ratio >= 4.5 ? 'informational, real rendered hover fill' : 'informational -- below 4.5:1, a real pre-existing gap, not enforced (#551 gate round 1, flagged not fixed)',
    })
  }
  return rows
}

// Code blocks render on `--card` (Shiki's own root background is neutralised, #975), so every non-self-backgrounded
// tokenColour of the preset's `syntaxTheme` is checked against `--card` at 4.5:1 (code is body text).
//
// A self-backgrounded scope is skipped only if confirmed unreachable: no bundled grammar emits `markup.ignored`/
// `markup.untracked`. `carriage-return` IS reachable (the `mdx` grammar's hard line break), so it stays in the loop.
const SELF_BACKGROUND_SCOPES_CONFIRMED_UNREACHABLE = new Set(['markup.ignored', 'markup.untracked'])
export function hexToLinearSrgb(hex) {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return [srgbGammaDecode(r), srgbGammaDecode(g), srgbGammaDecode(b)]
}

export { MARKDOWN_PAIRS, mermaidAccentRows } from './markdown-token-contrast.mjs'
export async function shikiTokenContrastRows(themes, themeMetadata) {
  const distinctSyntaxThemes = [...new Set(Object.values(themeMetadata).map((m) => m.syntaxTheme).filter((s) => s && s !== 'css-variables'))]
  const rows = []
  if (distinctSyntaxThemes.length === 0) return rows
  const highlighter = await createHighlighter({ themes: distinctSyntaxThemes, langs: [], engine: createJavaScriptRegexEngine() })
  const tokenColoursByTheme = new Map()
  for (const syntaxTheme of distinctSyntaxThemes) {
    const resolved = highlighter.getTheme(syntaxTheme)
    const colours = new Map()
    colours.set(resolved.fg.toLowerCase(), '(default text)')
    for (const entry of resolved.settings) {
      const fg = entry.settings?.foreground
      if (!fg) continue
      const scopeNames = Array.isArray(entry.scope) ? entry.scope : entry.scope ? [entry.scope] : []
      if (entry.settings?.background && (scopeNames.length === 0 || scopeNames.every((s) => SELF_BACKGROUND_SCOPES_CONFIRMED_UNREACHABLE.has(s)))) continue
      const scope = scopeNames.length > 0 ? scopeNames.join(', ') : '(default text)'
      if (!colours.has(fg.toLowerCase())) colours.set(fg.toLowerCase(), scope)
    }
    tokenColoursByTheme.set(syntaxTheme, colours)
  }

  for (const [themeId, props] of Object.entries(themes)) {
    const syntaxTheme = themeMetadata[themeId]?.syntaxTheme
    const card = props['card']
    if (syntaxTheme === 'css-variables') continue // #456: tokens checked in markdown-token-contrast.mjs
    if (!syntaxTheme || !card) {
      rows.push({ themeId, fg: 'shiki token colour', bg: 'card', min: 4.5, ratio: null, pass: false, note: `'${themeId}' has no syntaxTheme (themes.ts) or --card token (globals.css)` })
      continue
    }
    const cardLum = relativeLuminance(card.linear)
    for (const [hex, scope] of tokenColoursByTheme.get(syntaxTheme)) {
      const ratio = contrastRatio(relativeLuminance(hexToLinearSrgb(hex)), cardLum)
      rows.push({
        themeId,
        fg: `shiki:${syntaxTheme} ${scope}`,
        bg: 'card',
        min: 4.5,
        ratio,
        pass: ratio >= 4.5,
        fgHex: hex,
        bgHex: linearToHex(card.linear),
      })
    }
  }
  return rows
}
