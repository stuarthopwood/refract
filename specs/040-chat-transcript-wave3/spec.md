# Feature Specification: Chat transcript (wave 3)

**Feature Branch**: `wave-3-chat-transcript`
**Status**: Draft
**Input**: One PR for the wave 3 "Chat transcript" bundle in `docs/PLAN.md`: #1284, #1283, #907, #1130, #1210, #1220, #1262, #1041, #473, #719, #684, #746, #1098 and #896. Decisions: the 2026-10-29 wave 3 Chat transcript grill (a "Decided" comment on each issue) plus each issue's own earlier grill. Numbered 040: 030 to 039 are taken. The composer bundle (#1318) already added the shared `ComposerBox` and `ComposerPanel`; this bundle reuses them where they fit.

## Clarifications

### Session 2026-10-29 (wave 3 grill, Stuart)

- #1262: Stuart kept today's Note behaviour: the newest Note is a normal reply while it is the last row and collapses once a tool row follows. Every listed Medium and Low item is taken. The Note body stays brighter than the Thought body and the hierarchy is recorded in `docs/design/product-chat.md`. One shared clamp component replaces the `ClampedContent` and `StageContextBrief` copies.
- #1220: all seven findings; **Don't show again** underlines at rest.
- #473: the "Asked user" row, its Answered lines and resolved approvals form one tight run (`mt-1` inside, `mt-6` before and after). Pending cards keep `mt-6`. The multi-question first-only defect stays out of scope.
- #719: the default Rendered or Source view follows fixed rules on tool field and target path, never content sniffing. The toggle is on every plain-text section.
- #1098: ship the `parked` status on every row surface and a Rust subscription to `subagent_lifecycle`; probe the real wire string live. If the probe finds no reliable signal, ship the vocabulary only and leave #1098 open. The composer Subagents readout never shows a parked bucket (#1085 wins).
- #746: the proposal is confirmed for all pane banners (Worktree missing, Terminated unexpectedly, The agent stopped, start failed) via a shared `PaneBanner` and a documented text Button variant.
- #684 and #896: decided within the issue. Tint values start from the hand-calculated ones and are tuned live; the Readout rename has no behaviour change.
- #1284, #1283, #907, #1130, #1210, #1041 stand exactly as grilled in the issues. `src-tauri/src/omp/process.rs` and `process_args.rs` are not touched (#1287 owns the TLS fix).
- Clarify pass: no further ambiguity that changes the implementation.

## Requirements

- **FR-001** (#1284) A turn that ends in a model error shows a Turn error row with OMP's error text, a plain-language hint for TLS, auth and rate-limit errors, and a Retry button that resends the unanswered prompt once and removes the row when the new turn starts. While OMP retries, a live Retry line ("Retrying, attempt N of M") with Stop shows and replaces the current-work banner's retry text (the session-row retry text remains); Stop aborts the turn. Retry is hidden while OMP auto-retries and while the session is working (a queued resend would double-send). A prompt with attachments cannot be resent whole, so its row shows a re-attach hint instead of Retry.
- **FR-002** (#1283) Todo status icons align with the first line of their item text in the pinned panel and the Todo hover card (`TodoTaskRow`).
- **FR-003** (#907) The chat header title and branch truncate with a tooltip and never sit under the action buttons at 320 and 360 px.
- **FR-004** (#1130) The pinned todo list's scrollbar is flush with the pane edge and matches the transcript scrollbar; content keeps its 16 px inset.
- **FR-005** (#1210) Only the newest running transcript row shimmers, via the shared `.text-shimmer` and `ShimmerText`, honouring the "Animated status text" setting, reduced motion and a hidden window.
- **FR-006** (#1220) The seven gate findings on the Agent stopped bar, `SessionsSection` and stale `isOpening` comments are fixed.
- **FR-007** (#1262) The listed Medium and Low follow-ups on the mid-turn Note row are fixed, with one shared disclosure toggle class and one shared clamp component.
- **FR-008** (#1041) Every advisory row carries a shared `SourceTag` ("Advisor" with the eye icon); the advisor name moves into the tooltip and accessible name.
- **FR-009** (#473) Answered Ask lines, the ask row and resolved approvals form a tight run.
- **FR-010** (#719) The tool-call dialog renders markdown values through the existing sanitising `Markdown`, with a Rendered or Source toggle per section, Copy always copying source, and large values opening as Source.
- **FR-011** (#684) The focused pane in a split view has a body tint (`--pane-focused`), not a left bar; the header keeps the badge; high contrast uses a 2 px edge; new contrast pairs are checked.
- **FR-012** (#746) Pane banners are unboxed rows built from a shared `PaneBanner` with one outline primary and text buttons; Delete is red text; `components.md` and `patterns.md` carry the rules.
- **FR-013** (#1098) A `parked` status with its own icon and word appears on the `SubagentRow`, Stage header, chain roll-up and Subagents panel tree, fed by a probed `subagent_lifecycle` subscription.
- **FR-014** (#896) Readout Chip components and files are renamed to Readout with no behaviour change.

## Success criteria

- `pnpm ci:local` is green on the merged tree; the live check on a scratch exe shows the changed rows in Dark, Dark high contrast and one accent theme.
- No file grows past its `scripts/file-size-baseline.json` value; new files stay under 600 lines.
- No new tests (prototyping phase); existing tests keep passing.
