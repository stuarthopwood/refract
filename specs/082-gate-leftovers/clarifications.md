# Clarifications: spec 082

Resolved by the delegated grill (Skippy for Stuart, 2026-10-31); the full text is on #1481 and #1482. UI questions Q1-Q6 were ruled by ui-architect-v3 (layout, flow and visual specialists agreed on all six).

## Session 2026-10-31

- Q1: Home link wording "See all" or "Show all"? A: "Show all" (majority wording, already in `HomeSessionSections.tsx:86`). Accepted by the ruling.
- Q2: Should the pause button's accessible name equal its tooltip? A: Yes, so voice-control users can say what they see. Accepted.
- Q3: Fired-alarm action order and alignment? A: Re-arm first (outline), then Dismiss (quiet), left-aligned, 8 px gap. Accepted.
- Q4: Kebab label for screen readers? A: "More actions, <32-character snippet>", cut by code point so an emoji is never split (ruling suggestion, adopted: `Array.from`). Accepted with that alteration.
- Q5: Widen hit targets for `Switch` and inline links? A: No: WCAG 2.5.8 exempts inline links and the `Switch` size is a shared fixed value. Accepted.
- Q6: Empty Manage sessions "New session" action? A: Altered. Do not show a primary action that cannot work; keep the empty state that explains and points back to chat, and track the dialog change as a follow-up.
- Q7: Is a Spec Kit slash-command prompt available? A: No (`.specify` has the omp integration with templates only), so the specify, clarify, plan, tasks and analyze steps are authored by hand from `.specify/templates`.
- Q8: Do the Lane R theme files need changes? A: No. Nothing here touches the theme store, tokens CSS or `theme_files.rs`.
- Q9: Are tests added? A: No (prototyping phase); verification is the live check.
