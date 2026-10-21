// Issue #1122: the one shared selected-indicator bar for every persistent selected/active
// surface -- the "Pull requests" nav entry and Session rows (SessionList.tsx/SessionRow.tsx),
// the Settings nav (SettingsScreen.tsx), PR list rows (PullRequestRow.tsx), Explorer tree rows
// and the Subagent panel (FileExplorerPanel.tsx/SubagentPanel.tsx), and Manage sessions rows
// (ManageSessionRow.tsx). Flush full height (`inset-y-0`, no rounded caps), 2px wide, the shared
// `--active-indicator` accent, with its own forced-colours fallback baked in so selection
// survives Windows High Contrast at every call site, not just the ones that already carried one.
// Replaces the hand-copied `<span>` this shape used to drift apart at (five-plus call sites: some
// rounded-pill/inset, one missing the forced-colours fallback entirely).
//
// The transient dropdown/menu keyboard-focus bar (`dropdown-menu.tsx:118-119`, issue #564) is a
// separate, narrower rule scoped to transient Radix dropdown/radio menus (focus, not selection)
// and keeps its own hand-written span -- this component is for persistent selection only.
export function ActiveIndicatorBar() {
  return (
    <span
      aria-hidden
      className="absolute inset-y-0 left-0 z-10 w-0.5 bg-active-indicator forced-color-adjust-none forced-colors:bg-[Highlight]"
    />
  )
}
