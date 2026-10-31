# Clarifications: spec 085

Resolved by the delegated grill (Skippy for Stuart, 2026-10-31); full text on #1486. UI questions Q1-Q5 were ruled by ui-architect-v3.

## Session 2026-10-31

- Q1: Per-tab close hover and brightness? A: muted by default, `text-foreground` on hover, focus and active; active hover `hover:bg-foreground/10`; add `aria-keyshortcuts="Delete"`.
- Q2: Pause label and pausing icon? A: labels carry the session name; pausing uses `Undo2Icon`.
- Q3: Switch-to button tooltip? A: shared Tooltip "Switch to {name}", keep `h-6`.
- Q4: Home "Show all" duplicates? A: keep visible text; distinct `aria-label`s.
- Q5: Kebab tooltip? A: full label including the snippet.
- Q6: Is a Spec Kit slash-command prompt available to this lane? A: No; the artefacts are authored by hand from `.specify/templates` in the same order (specify, clarify, plan, tasks, analyze, implement).
- Q7: Which `aria-disabled` buttons lose `pointer-events-none`? A: those whose handler already guards busy. The MergeDialog radio keeps it (not a button; selects on click). The git-changes kebab trigger gets an `onPointerDown` guard because Radix opens on pointerdown.
- Q8: Does the 072 flake get a fix? A: No, no reproducible root cause.
