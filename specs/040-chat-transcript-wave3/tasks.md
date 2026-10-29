# Tasks: Chat transcript (wave 3)

Spec: `spec.md`. Plan: `plan.md`. No new tests (prototyping phase). Commit and push after every task. Every worker reports changed files. Safe deletion: literal absolute paths only, nothing deleted inside the repo except named scratch files. No cargo or tauri command until the director grants the build slot.

## WP-A Rename and quick fixes
- [x] T1 Rename Readout Chip files and components to Readout; update imports, docs and CONTEXT.md avoid-notes. (#896)
- [x] T2 Todo icon alignment in `TodoTree.tsx`. (#1283)
- [x] T3 Chat header title and branch truncation with tooltip. (#907)
- [x] T4 Pinned todo scrollbar flush with the pane edge. (#1130)
- [x] T5 Agent stopped bar and Sessions section polish, stale comments. (#1220)
- [x] T6 Tight run for ask, Answered lines and resolved approvals; `DESIGN.md` rhythm. (#473)

## WP-B Banners and errors
- [ ] T7 Shared `PaneBanner`, Button `text` variant, migrate the ChatPane banners; `components.md` and `patterns.md`. (#746)
- [ ] T8 Turn error row with hints and Retry; Retry line with Stop; keep banner and session-row retry text. (#1284)

## WP-C Transcript rows
- [ ] T9 Mid-turn Note follow-ups, shared disclosure class and shared clamp, `product-chat.md` hierarchy. (#1262)
- [ ] T10 Shared `SourceTag` and advisory rows. (#1041)
- [ ] T11 Newest running row shimmer; motion and accessibility docs. (#1210)

## WP-D Tool dialog
- [ ] T12 Rendered or Source toggle, default rules, large-value guard. (#719)

## WP-E Split focus
- [ ] T13 Pane tint tokens, layer, badge token, contrast pairs, docs. (#684)

## WP-F Parked agents
- [ ] T14 Probe `subagent_lifecycle` wire values against a real OMP; record on #1098. (#1098)
- [ ] T15 Rust subscription and mapping; `parked` status through the renderer vocabulary and surfaces. (#1098)

## Wrap-up
- [ ] T16 PLAN.md row, reviewer gate, build slot, ci:local, live check, PR.
