# Future increments (carved out of spec 013)

Per the constitution's SpecKit Incremental Enhancement rule, these are carved out rather than
deleted so the decision history survives: each is a genuinely open question `issue://538` and
`docs/design/accessibility.md` both record as unresolved, not something this spec's own scope
needs answered to be task-ready.

## Rail-icon counts while the pane is collapsed

`issue://538`'s own Open list: "whether rail icons also carry counts while the pane is
collapsed (proposed)." Proposed, not decided. Spec 013 only renders counts on tabs and the
launcher list, both of which are only ever visible while the pane is open — a collapsed rail
button shows no count in this spec. Revisit once Stuart decides; likely a small addition to
`HostedPanelDescriptor`'s rendering, not a data-model change (the count is already computed).

## Persistence of open panels, order, and width across a restart

`issue://538`'s own Open list and `docs/design/components.md`'s "Tabs and the right pane" Open
line both list this unresolved. Spec 013's `RightPaneState`/`OpenPanelsState` are in-memory only
(zustand, not persisted to `settings.json`); every app launch starts collapsed with no panels
open, matching today's Subagents-only behaviour. If persisted later, the natural home is a new
`Settings.rightPane` field following `Settings.split`'s existing persisted-layout shape (spec
005), not a new storage mechanism.

## A keyboard shortcut to toggle the pane

`issue://538`'s own Open list: "a toggle shortcut." `docs/design/index.md`'s Keyboard table has no
entry for it today. Spec 013 does not add one; every panel remains reachable via Tab plus the
rail buttons and tab strip. Revisit alongside the still-open `docs/PLAN.md` Decision #9/#10 items
about other keyboard shortcuts, so shortcuts are reviewed together rather than one at a time.

## Whether the future global Agents panel changes this spec's count or binding rules

`issue://538`: "Per-Session or global panels... Decide whether it is one new spec or an amendment
of spec 004 and 005." Spec 013 resolves the *shell ownership* question (see spec.md
Clarifications) but not this narrower one: once `docs/PLAN.md` row C2c (issue://490) replaces the
per-Session Subagents panel with a global, cross-Session Agents panel, the rail icon, its count
source, and FR-013's "bound to the focused Session" rule will all need revisiting. Out of scope
here; C2c's own spec inherits this file's `HostedPanelDescriptor`/`OpenPanelsState` shapes and
amends only the Subagents entry's binding and count source, not the shell itself.
