// Issue #1122: the one shared selected-indicator bar for every persistent selected/active surface
// -- the "Pull requests" nav entry and Session rows (SessionList.tsx/SessionRow.tsx), the Settings
// nav (SettingsScreen.tsx), PR list rows (PullRequestRow.tsx), Explorer tree rows and the Subagent
// panel (FileExplorerPanel.tsx/SubagentPanel.tsx), and Manage sessions rows (ManageSessionRow.tsx),
// plus the collapsed group header's containment cue (GroupHeader.tsx, bar only).
export function ActiveIndicatorBar() {
  return (
    <span
      aria-hidden
      className="absolute inset-y-0 left-0 z-10 w-0.5 bg-active-indicator forced-color-adjust-none forced-colors:bg-[Highlight]"
    />
  )
}
