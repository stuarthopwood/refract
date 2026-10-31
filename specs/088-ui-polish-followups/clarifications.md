# Clarifications: spec 088

Resolved by the delegated grill (Skippy for Stuart, 2026-10-31); full text on #1449 (issuecomment-6539398047) and #1443 (issuecomment-6539398338). UI questions were ruled by ui-architect-v3.

## Session 2026-10-31

- Q1: Invalid-field cue beyond colour? A: `aria-invalid:ring-1 aria-invalid:ring-destructive` on Input, Textarea and the select trigger.
- Q2: Select trigger ring width onto `--field-ring-width`? A: No; keep `ring-2` (ghost control, token is 0px outside high contrast). Document select triggers in the quiet-field departure.
- Q3: Select list direction? A: `popper` default, opens below.
- Q4: Open on GitHub and Copy link? A: shared `OpenOnGitHubButton` plus `CopyButton` "Copy link" in both headers; `IssueCreatedPanel` footer unchanged.
- Q5: PR header wrapping? A: one title row, title `line-clamp-2`, actions `shrink-0`.
- Q6: Draft reason? A: visible line, drop `title`.
- Q7: Merge button vs docs? A: button becomes `outline`.
- Q8: Request card Cancel? A: beside Send for text input.
- Q9: IconRail top inset? A: none.
- Q10: Empty spacer row? A: remove.
- Q11 (Skippy): Theme tokens, contrast-pair script, `.titlebar-surface` comment? A: skipped, Lane W owns them (spec 086).
