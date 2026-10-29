// Shared link-style classes, extracted out of `Markdown.tsx` (issue #1077, gate round 1 fix)
// so `src/renderer/components/InlineDisclosure.tsx` can reuse `mutedLinkClassName` without an
// import cycle back through `Markdown.tsx` (which itself imports `InlineDisclosure` for
// `MermaidBlock`'s own "Show source" toggle). `Markdown.tsx` re-exports both names unchanged, so
// every existing caller (`StageContextBrief.tsx`, `StageDependencies.tsx`, `ToolCallDialog.tsx`)
// keeps importing from `./Markdown` with no other change.
export const linkClassName =
  'text-accent-text underline underline-offset-2 hover:decoration-2 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

// Issue #610, decision 9: `--accent-text` does not clear 4.5:1 on `bg-muted` (check-theme-
// contrast.mjs's own `accent-text`/`muted` pair), so a link on a muted surface drops the accent
// colour and relies on the ambient (already-passing) text colour it already inherits, instead.
export const mutedLinkClassName =
  'underline underline-offset-2 hover:decoration-2 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

// The one muted text-link disclosure toggle (Show more / Show less, Show full brief, Show source):
// the muted link look plus a 24px target (WCAG 2.5.8). Callers add their own spacing above it.
export const disclosureToggleClassName = `min-h-6 inline-flex items-center text-xs text-muted-foreground ${mutedLinkClassName}`
