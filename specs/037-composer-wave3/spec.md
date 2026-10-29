# Feature Specification: Composer (wave 3)

**Feature Branch**: `wave3-composer`
**Status**: Draft
**Input**: One PR for the wave 3 "Composer" bundle in `docs/PLAN.md`: #839 (amended 2026-10-28), #1149, #1145, #1129, #675, #1258, #1265, #1268, #496, #865 and #1084, plus two issues pulled in by the grill: #1140 (hard prerequisite of #496's Ask and remember) and #712 (the data #865's banner needs). Decisions: the 2026-10-29 wave 3 Composer grill (a "Decided" comment on each issue). Numbered 037: 030 to 033, 035 and 036 are taken. This PR lands before the Chat transcript bundle because both touch `MessageInput.tsx` and `ChatPane.tsx`.

## Clarifications

### Session 2026-10-29 (wave 3 grill, Stuart)

- #496 scope: Todo-first ordering in the status line plus the fourth Approval mode, **Ask and remember** (`--approval-mode always-ask-cached`, second in the menu, default stays Ask), `/forget-approvals` in the supported command lists, and file/folder grants in the Approve split button menu. Stuart chose to pull **#1140** into this PR so OMP's exact option label is answered per request ("Approve Once" when grants exist). #1140 lands first in the work order; Ask and remember is not selectable before it works.
- #1268 decision: **split** a separate `AiCreditsChip` driven only by `showAiCredits` (reverses the earlier "fold into ContextUsageChip" decision). It is a `<button>` like `AdvisorChip`. Remaining Mediums and Lows ride along: Rust plan cache holds failures for about 30 s, the readout chip target is 24 px (`READOUT_CHIP_INTERACTIVE_ADDITIONS`), lock poisoning, a11y checks, wording and stale comments.
- #865 scope: build the pinned, non-modal banner and its `status` feedback channel in `docs/design/patterns.md`, and pull the **#712** data fix (background agents stay Running across turns; not marked Finished at spawn) so the banner tells the truth. The banner lists running background agents with elapsed time and links into the Agents panel; no pool-limit counter.
- #1084 decision: per-theme selection alpha with higher headroom where available; Dark high contrast stays bound by its 7:1 text floor. Comments reworded to name the real constraint. The ink-check ordering bug and exe provenance gap are fixed in the verify scripts (existing scripts only).
- #839 (as amended): composer text is Geist at 13 px (`--text-readout`); ghost text, command pill overlay and chip overlays move with it; code spans stay Geist until #1170; `product-look-and-feel.md` line 13 is updated.
- #675 scope: a shared presentational `ComposerBox` used by `MessageInput` and `SideChatPanel`, including the side chat's round Send, Stop-slot Cancel and icon-only Clear thread. The full #812 god-file split is not in scope; `MessageInput.tsx` only shrinks.
- #1265 (assumed, delegated): fix the layout jump with a fade honouring reduced motion, the resumed-timer flash and the misleading `git-failed` error code. The end-of-turn screen-reader cue stays out (Stuart's earlier grill decision).
- #1258 (assumed, delegated): every listed item is done, including the `settings.rs` extraction (588 of 600 lines).
- #1149, #1145 and #1129 stand exactly as grilled on 2026-10-21 (see the issues).
- Clarify pass: no further ambiguity that changes the implementation.

## Requirements

- **FR-001** (#839) The composer textarea and every mirror layer use the UI font (Geist) at `--text-readout` (13 px) with identical font, size, line height and letter spacing; the Code ligatures setting no longer affects the composer.
- **FR-002** (#1149) A `--composer-placeholder` token per theme drives the placeholder overlay (about 40% white in the dark family; Dark high contrast keeps `--muted-foreground`; forced colours keep `GrayText`). The pair is in `scripts/theme-contrast-pairs.mjs` with its own floor, recorded as an accepted departure in `docs/design/accessibility.md`.
- **FR-003** (#1145) A `QueuedPanel` between `PinnedTodoPanel` and `MessageInput` lists queued messages as rows ("Queued · N", collapse chevron, truncated text with tooltip, ghost Send now, Remove, "Sending at the next step" for steering rows), with a max height and scrollbar on the pane edge. Chip derivation and handlers leave `MessageInput.tsx`. Focus returns to the textarea when the last row goes.
- **FR-004** (#1129) The model picker filter box radius is `max(0px, calc(var(--radius-lg) - 0.25rem))`; shared `input.tsx` is unchanged.
- **FR-005** (#675) `ComposerBox` renders the box, border, radius, padding, field styling, action slot and optional status row for both composers; at 240 px nothing clips.
- **FR-006** (#1140) The approval card's Approve is a split button; Rust carries the request's `options` and answers with the chosen option's exact label.
- **FR-007** (#496) The Approval menu gains Ask and remember (second); grants menu entries and the "Remember across sessions" toggle appear on the split button when a request carries grants; `/forget-approvals` is supported; the Todo chip precedes the Changes chip.
- **FR-008** (#712) Background (async) `task` agents appear as Running from spawn, persist across turns, and settle with real status and duration.
- **FR-009** (#865) A status banner above the composer lists running background agents with elapsed time and opens the Agents panel; icon plus word, never colour alone; `patterns.md` gains the `status` channel.
- **FR-010** (#1268) `AiCreditsChip` is independent of `ContextUsageChip`; readout chip targets are at least 24 px; failed plan lookups are cached for about 30 s.
- **FR-011** (#1258, #1265) Shimmer tone and duration are variables; one shared visibility hook; the banner gap sits on the parent; the turn-line vanish fades; the resumed timer does not flash.
- **FR-012** (#1084) Verify scripts sample resting ink before selecting; exe provenance (hash and mtime) is recorded; selection contrast uses per-theme alpha with the real constraint documented.

## Success criteria

- `pnpm ci:local` is green; the live check on a scratch exe shows the composer, queued panel, approvals, banner and side chat in Dark, Dark high contrast and one accent theme.
- `MessageInput.tsx` is at or below its `scripts/file-size-baseline.json` value.
- No new tests (prototyping phase); existing tests keep passing.
