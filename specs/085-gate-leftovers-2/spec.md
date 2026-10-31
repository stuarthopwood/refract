# Spec 085: gate leftovers from spec 082, plus two #1485 items

Issues: #1486 (spec 082 gate Lows and skipped items), #1485 (only the `aria-disabled` pointer-events and press-nudge items). Branch `gate-leftovers-1486` (Lane V). Decisions: the "Decided (Skippy, delegated by Stuart 2026-10-31)" comment on #1486; see `clarifications.md`. No new tests (prototyping phase); existing tests must keep passing. No theme token, Mermaid, Shiki or scrollbar colour files are touched (Lane U, #1474).

## Problem

The spec 082 gate left Lows on focus outlines in forced-colors mode, icon-button labels and states, hit-target lint, Rust display-name cleaning and live-check selectors. Separately, about a dozen buttons still carry a local `aria-disabled:pointer-events-none`, which blocks the reason tooltip on a busy or disabled button, and the base Button still nudges down on press when `aria-disabled`.

## User stories

- US-1 As a forced-colors user, an inset focus outline stays inset on every control that uses it.
- US-2 As a keyboard or screen-reader user, the per-tab close announces Delete, the pause button names its session and shows an icon that matches its action, and the two Home "Show all" buttons have distinct names.
- US-3 As a pointer user, hovering a busy or disabled button shows its reason tooltip, and a busy button does not appear to press.
- US-4 As a maintainer, `check:hit-targets` catches rem sizes and the baselines carry no stale entries.
- US-5 As a user with a hostile GitHub profile name, invisible format characters cannot reach the UI and an empty name falls back to the login.

## Functional requirements

- FR-001 One shared `INSET_FOCUS_OUTLINE_CLASS` (`components/ui/focus-classes.ts`) includes `forced-colors:focus-visible:outline-offset-[-2px]`; `PanelTabBar`, `GitChangesPanel` and `AdvisoryRow` use it.
- FR-002 Per-tab close: `aria-keyshortcuts="Delete"`; muted icon, `text-foreground` on hover, focus-visible and on the active tab; visible hover on the active tab.
- FR-003 ChatHeader pause labels "Pause {name} after this turn", "Cancel pause for {name}", "Resume {name}"; the pausing state shows `Undo2Icon`. The "Switch to {name}" button uses the shared Tooltip with the same text, not native `title`, and keeps its 24 px height.
- FR-004 Home "Show all" buttons keep their visible text and gain `aria-label` "Show all pull requests" and "Show all issues".
- FR-005 MessageMenu kebab tooltip equals "More actions, {snippet}"; the snippet is cut by grapheme (`Intl.Segmenter`); the `useMemo` is removed.
- FR-006 `check-hit-targets` `SMALL_TARGET` matches arbitrary rem sizes under 1.5rem; the stale `MessageMenu.tsx` entry leaves `icon-only-controls-baseline.json`.
- FR-007 Rust: `truncate_display_name` also strips Unicode format and bidi characters; a name empty after cleaning becomes `None` (`github/profile.rs`).
- FR-008 `verify-tauri-076.mjs` message kebab selector excludes `More actions for ...`.
- FR-009 #1485: local `aria-disabled:pointer-events-none` removed from every button whose click handler already guards busy; the git-changes kebab trigger guards `onPointerDown`; the base Button press nudge excludes `aria-disabled`.
- FR-010 Live check `scripts/verify-tauri-085.mjs` screenshots each changed control, hovers an `aria-disabled` button to prove its reason tooltip shows, and writes `report.json` with the code `gitHead`.

## Items: done and skipped

See `tasks.md` for the per-item status and file references.

| Item | Result |
|---|---|
| Items under "Skipped from #1481 and #1482" in #1486 | skipped, reasons in `specs/082-gate-leftovers/spec.md` |
| 072 live-check timing flake | skipped: no reproducible root cause |
| MergeDialog `RadioGroupItem` pointer-events | kept: a radio, selection happens on click |

## Success criteria

- `pnpm ci:local` passes. `verify-tauri-085.mjs` passes from the committed HEAD and `report.json.gitHead` equals it.
- Six-reviewer gate: PASS from every gating reviewer after the last code change.
