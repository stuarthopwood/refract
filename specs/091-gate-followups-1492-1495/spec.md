# Spec 091: gate follow-ups from specs 085 and 087

Issues: #1492 (spec 085 gate Lows and Mediums) and #1495 (spec 087 gate follow-ups). Branch `gate-followups-1492-1495` (Lane AB). Decisions: the "Decided (Skippy, delegated by Stuart 2026-10-31)" comments on both issues; see `clarifications.md`. No new tests (prototyping phase). Lane AA (spec 090) owns the updater, spellcheck, Question card, suspect-window warning, Settings notice and Next stepping files; none is touched here.

## Problem

Busy (`aria-disabled`) buttons still show hover styles, the git file kebab does not say why it is unavailable, `IconButton` does not expose its shortcut to assistive tech, the roster open check follows a symlinked `.omp` parent, `CompactList` text is hover-only when truncated, and the theme store can roll back to a stale custom theme or leave one saved.

## Functional requirements

- FR-001 `button.tsx` hover rules are gated by `not-aria-disabled:`, so every busy button loses hover styling in one place.
- FR-002 The git file kebab label says "unavailable while another action finishes" while an action is pending (it is also the tooltip).
- FR-003 `IconButton` derives `aria-keyshortcuts` from `shortcut` (Ctrl becomes Control, Esc becomes Escape); an explicit prop wins, and the Ctrl+N repository button passes `undefined` to stay unadvertised.
- FR-004 The ChatHeader Switch-to button sets `aria-describedby={undefined}` so the label is not read twice.
- FR-005 `messageSnippet` ends in an ellipsis only when real (non-whitespace) content was cut.
- FR-006 `PanelTabBar` explains why its `dark:` hover class overrides the ghost style.
- FR-007 `advisor_roster::openable_target` canonicalises the file and requires it to equal `<canonical root>/<known name>`; the opener receives the canonical path.
- FR-008 `CompactList` wraps text instead of truncating; an item with a `title` gets a focusable row with the shared tooltip.
- FR-009 Theme store: `save` rolls back to the persisted custom theme; `saveCustom` catches a thrown IPC error; a stale custom reply clears itself when the latest pick was a built-in.
- FR-010 `ShowHiddenToggle` names its 600 ms announce delay; the session Details card Show in File Explorer disabled state adds a not-allowed cursor and a forced-colors grey, not opacity alone.
- FR-011 Live check `scripts/verify-tauri-091.mjs` screenshots each changed surface and writes `report.json` with the code `gitHead`.

## Items skipped

| Item | Result |
|---|---|
| components.md radio exception and INSET_FOCUS note (#1492) | skipped: Lane AA edits `docs/design/components.md` in the same region |
| `profile.rs` strips U+FE0F and tag characters (#1492) | skipped: cosmetic; tag characters carry ASCII smuggling, so loosening a security filter for emoji presentation is a bad trade |
| `verify-tauri-085.mjs` idle pause, press-nudge source grep (#1492) | skipped: script-only, no product defect |
| `Sparkline` summary memo (#1495) | skipped: series are at most a few dozen points, no measured cost |
| `verify-tauri-087.mjs` gaps (#1495) | skipped: needs fake-gh labels and a scratch repo with changes; cost outweighs it |
| `aria-keyshortcuts="Delete"` on the tab (#1492) | already done: `PanelTabBar.tsx` close button carries it |

## Success criteria

- Typecheck, vitest and every `check:*` script pass; `ci:local` passes. `verify-tauri-091.mjs` passes from the committed HEAD and `report.json.gitHead` equals it.
- Six-reviewer gate: PASS from every gating reviewer after the last code change.
