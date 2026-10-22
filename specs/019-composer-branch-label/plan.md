# Implementation Plan: Live branch label in the composer strip

**Branch**: `feat/p1-composer` | **Date**: 2026-10-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/019-composer-branch-label/spec.md`

## Summary

Show the live checked-out branch of each pane's Session worktree in the composer's bottom row,
after the Reasoning picker, as a ghost button that opens the Git changes panel. The Rust readout
already computes `branch` (`session/readout.rs::compute_branch`) and pushes it with every
`readout:update`; this plan adds a HEAD-directory watch so a switch made outside a turn refreshes
the readout within about a second, and a renderer component that renders the value.

## Technical Context

**Language/Version**: TypeScript 5 / React 19 (renderer); Rust 2021 (Tauri v2 backend)
**Primary Dependencies**: `notify` (already a dependency, used by `fs/watch.rs`), lucide-react, Radix Tooltip
**Storage**: None (the value lives on `SessionReadout.branch`, already in `src/shared/model.ts`)
**Testing**: No new tests (prototyping rule); verified live on a scratch instance
**Target Platform**: Windows desktop (Tauri v2, WebView2)
**Constraints**: 600-line cap per source file (`MessageInput.tsx` and `readout.rs` must not grow past their limits); reusable components (ADR 0003)

## Constitution Check

- Principle II (OMP is the engine): no OMP change; git is read directly, as the readout already does.
- Principle IV (Windows first): the watch resolves HEAD with `git rev-parse --git-path HEAD` and watches its containing directory (non-recursive), since git replaces HEAD through `HEAD.lock` and a rename.
- Principle V (Tauri security baseline): no new IPC command; the value travels on the existing `readout:update` event.
- File size (issue #806): the watcher is a new module `src-tauri/src/session/readout_head_watch.rs`; the label is a new component `src/renderer/features/chat/ComposerBranchLabel.tsx`.

## Decisions (research)

1. **Reuse the readout, not the Git changes store.** The Git changes store loads a full status snapshot only while its panel is mounted; the readout's `branch` is already live for every Session and seeds a reopened or split pane from `SessionSnapshot.readout`.
2. **Watch target.** `git rev-parse --git-path HEAD` from the worktree (relative output resolved against the worktree). Watch the parent directory non-recursively; react only to events whose file name is exactly `HEAD`; debounce 150 ms (first event of a burst arms one timer), then push the newly read branch on the last readout at once (a branch-only fast path: the full recompute also runs the diff stat, several git processes that took about 2 s on a loaded Windows box in the live check) and `schedule_readout_update` (its own 100 ms coalesce) for the full recompute.
3. **Lifetime.** Start in `readout::on_launch` (first pass of its loop, where the worktree path is read); stop in `readout::on_exit`. A static map keyed by Session id holds one watcher per Session; starting replaces any previous one. The callback holds a `Weak<SessionAgent>`.
4. **Truncation.** The label sits in the row's `flex-wrap` container with `flex: 1 1 0`, `max-width: max-content` and a small minimum width, so it never forces a wrap by its own length and shrinks before any sibling; the Reasoning picker keeps `shrink-0` and the model picker keeps its natural width.
5. **Control.** A `button` styled with the shared `PICKER_TRIGGER_CLASS` (same ghost trigger as the Model and Reasoning pickers, 24px tall), `aria-label` "Branch: <name>. Open Git changes panel", Radix Tooltip with `aria-describedby={undefined}`. Activation calls `openHostedPanel('git-changes', sessionId, { opener })`, as `ChangesChip` does.

## Project Structure

```text
specs/019-composer-branch-label/
├── spec.md
├── plan.md
├── tasks.md
└── checklists/requirements.md

src-tauri/src/session/
├── readout_head_watch.rs        # new: per-Session HEAD directory watch
├── readout.rs                   # start/stop hooks (2 lines)
└── mod.rs                       # module declaration

src/renderer/features/chat/
├── ComposerBranchLabel.tsx      # new: the label button and tooltip
└── MessageInput.tsx             # renders it after ReasoningPicker
```

## Complexity Tracking

None.
