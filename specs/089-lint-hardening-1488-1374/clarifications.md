# Clarifications: spec 089

Resolved by the delegated grill (Skippy for Stuart, 2026-10-31); full text on #1488 and #1374.

## Session 2026-10-31

- Q1: Comment stripping? A: reuse `scanTypeScriptComments`; no new parser.
- Q2: Quoted short hex selectors? A: exclude `url(...)` and DOM selector call arguments; quoted colours still count.
- Q3: Inline all-letter words? A: need a digit or one repeated letter; `#abc` inline is an accepted miss.
- Q4: `rgb()`/`hsl()`? A: count with numeric first argument; baseline the one ColorPicker gradient.
- Q5: Stale comment-density baseline? A: fail, do not auto-prune.
- Q6: Is a Spec Kit slash-command runnable by this lane? A: No; artefacts are authored by hand in order.
- Q7: Already fixed? A: the literal-colours stale-baseline failure already exists on main; no work.
