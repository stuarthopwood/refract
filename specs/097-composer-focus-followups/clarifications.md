# Clarifications (spec 097)

- Q: Which Mediums? A: All. Which Lows? A: Every local one (issue comment, items 1 and 2).
- Q: Are the 092 script changes tests? A: No, they are hardening of an existing live check and are in scope (item 3). A new `verify-tauri-097.mjs` only if 092 cannot cover a new focus path.
- Q: Reveal tooltip wording? A: Follows the pressed state: "Show secret" when masked, "Hide secret" when revealed. `aria-pressed` stays so assistive tech still reports the toggle state; the visible pressed style is `aria-pressed:bg-muted`.
- Q: Where does the ghost hover go? A: `CardFooter` paints `bg-row-hover-bg`, so the dark ghost hover must be `muted` there; the `ghost` variant gets an `in-data-[slot=card-footer]` rule, and both call sites drop the override.
- Q: Does the issue close on merge? A: Yes.
