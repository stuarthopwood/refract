# Clarifications: spec 081

### Session 2026-10-31 (self-grill, Skippy delegated by Stuart; ui-architect-v3 ruling; recorded on #1472 and #1479)

- Q: Where are defaults declared? [Decided] Once, on `:root` plus the five `.theme-*` classes, so the contrast probe resolves them on its own theme class. Recorded on #1472.
- Q: How granular? [Decided] bg/fg/border per element; a state token only where the state looks different today.
- Q: Which proposed tokens are cut? [Decided] `button-default-*`, `popover-panel-*`, `session-unread-dot`: existing roles already do that job.
- Q: Contrast warnings per token? [Decided] One pair per token in `check:theme-contrast`; about 10 representative pairs in the renderer list.
- Q: Manage sessions table row? [Decided] Out of scope; keeps its roles.
- Q: #1479 items to skip? [Decided] Kebabs out of the Tab order, merge with `TranscriptKebab`, the symlink TOCTOU. Recorded on #1479.
- Q: Light themes, in-app editor? [Decided: no] Unchanged from spec 078.
