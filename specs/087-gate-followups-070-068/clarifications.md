# Clarifications: spec 087

Resolved by the delegated grill (Skippy for Stuart, 2026-10-31); full text on #1452 and #1446. UI questions were ruled by ui-architect-v3.

## Session 2026-10-31

- Q1: Details card actions? A: ghost icon buttons with tooltips at the end of the path row; drop the footer.
- Q2: Distinct reveal icon? A: `FolderSearchIcon`; pickers keep `FolderOpenIcon`.
- Q3: Chat width without "Current"? A: Theme's ring and dot, `max-w-sm`; selection reads from the dot, `bg-muted`, `font-medium` and `aria-checked`.
- Q4: Pill removal announcement? A: "Removed label filter {name}" through `useChatAreaAnnouncer`.
- Q5: Blur on fast fetches? A: ~150 ms delay inside `LoadingOverlay`; `aria-busy` and `inert` immediate.
- Q6: Sparkline screen-reader alternative? A: extend the `aria-label` with latest, low and high.
- Q7: Show hidden auto-off and stale toast? A: announce through the shared announcer (the toggle unmounts); dismiss the Hide toast by id on unhide.
- Q8: Git-changes header hover? A: drop outer `group`, reuse one exported header action class.
- Q9: Agents badge token and Obsidian contrast? A: skip; spec 086 owns them.
- Q10: Sargable usage filter? A: skip; cost outweighs benefit now.
- Q11: Is a Spec Kit slash-command prompt available to this lane? A: No; artefacts are authored by hand from `.specify/templates` in order (specify, clarify, plan, tasks, analyze, implement).
