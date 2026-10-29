# Tasks: Composer (wave 3)

Spec: `spec.md`. Plan: `plan.md`. No new tests (prototyping phase). Commit and push after every task. Every worker reports changed files. Safe deletion: literal absolute paths only, nothing deleted inside the repo except named scratch files. No cargo or tauri command until the director grants the build slot (typecheck, vitest and node scripts are fine).

## WP-A Composer shell
- [ ] T1 Extract `ComposerBox` (box, border, radius, padding, field, action slot incl. Send/Stop, optional status row); use it in `MessageInput` and `SideChatPanel` (round outline Send, Stop-slot Cancel "Cancel side question", icon-only Clear thread with `aria-disabled` and reason tooltip). 240 px check. (#675)
- [ ] T2 Geist 13 px on textarea and every mirror layer; update `product-look-and-feel.md` line 13. (#839)
- [ ] T3 `--composer-placeholder` token per theme, contrast pair and accessibility.md departure. (#1149)
- [ ] T4 Verify-script fixes, per-theme selection alpha, comments reworded, exe provenance. (#1084)

## WP-B Queued panel and picker (after A)
- [ ] T5 `QueuedPanel` plus hook, mounted in `ChatPane` between `PinnedTodoPanel` and `MessageInput`; remove chip code from `MessageInput.tsx`. (#1145)
- [ ] T6 ModelPicker filter radius. (#1129)

## WP-C Approvals
- [ ] T7 Carry request `options` Rust to renderer; answer with exact label; split Approve button with "More approve options" menu. (#1140)
- [ ] T8 Ask and remember mode (TS + Rust + store), menu order, grants with their "Always" pairs, `/forget-approvals`. (#496)
- [ ] T9 Todo chip before Changes chip. (#496)

## WP-D Background agents
- [ ] T10 Probe OMP async task behaviour and subagent frames; record on #712. (#712)
- [ ] T11 Keep async agents Running across turns; settle with real status and duration. (#712)
- [ ] T12 Status banner component, mounted above the composer, link into the Agents panel; `patterns.md` status channel. (#865)

## WP-E Readout and status text
- [ ] T13 Shimmer tone/duration vars, shared visibility hook, selection fix, motion doc rows, wording, `setAnimatedStatusText` result, banner gap, `settings.rs` extraction. (#1258)
- [ ] T14 Fade for the settled turn line, resumed-timer flash, error code. (#1265)
- [ ] T15 `AiCreditsChip`, 30 s failure cache, 24 px target, lock handling, a11y labels, wording, comments. (#1268)

## Wrap-up
- [ ] T16 PLAN.md row, CONTEXT.md terms (Queued panel, Status banner, Ask and remember), reviewer gate, build slot, live check, PR.
