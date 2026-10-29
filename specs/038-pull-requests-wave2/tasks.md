# Tasks: Pull requests (wave 2)

Order: WP1 and WP2 in parallel (disjoint files), then WP3. No new tests; existing stay green.

## WP1 Rust backend and shared types
- [x] T001 GraphQL query: `__typename`, `avatarUrl`, `lastEditedAt` on authors and comments (`gh_mutations.rs`); map to `PullRequestActor.kind/avatarUrl` and `edited` (FR-003)
- [x] T002 `statusCheckRollup` entries to `PullRequestDetail.checks`, plus `viewerLogin` (FR-003, FR-012)
- [x] T003 `close_pull_request` mutation, IPC `pullRequests.close`, `ipc.ts` constant and bridge entry (FR-010)
- [x] T004 `github/images.rs` + IPC `pullRequests.fetchImage` per ADR 0004, bridge entry (FR-006)
- [x] T005 Update `check:parity` inputs and any contract fixtures the new channels need

## WP2 Shared renderer pieces
- [x] T006 `Markdown.tsx` alerts + tokens (all themes, `check:theme-contrast` green) (FR-004)
- [x] T007 `Markdown.tsx` GitHub-style tables, link colour, optional `resolveImage` (FR-005, FR-006)
- [x] T008 `components/relative-time.tsx` (FR-007)
- [x] T009 `components/markdown-editor/` editor, toolbar, helpers, full and compact sizes (FR-008, FR-013)

## WP3 Pull requests screens (after WP1 and WP2)
- [x] T010 `TimelineCards.tsx`: history line, commit grouping, soft cards, Author kind header (FR-001 to FR-003)
- [x] T011 `ThreadReply.tsx`: ghost Reply toggle, compact editor, draft kept, focus return (FR-009)
- [x] T012 `CommentBox.tsx`: full editor, Comment, Close pull request with confirmation (FR-010)
- [x] T013 `ChecksSection.tsx` and mount (FR-011, FR-012)
- [x] T014 Use `RelativeTime` in list rows and cards; wire `resolveImage` for the Pull requests Markdown (FR-005 to FR-007)
- [x] T015 `docs/design/components.md`, `docs/PLAN.md` row, CONTEXT.md touch-ups; file-size baseline unchanged

## Gate
- [x] T016 Typecheck, lint, `check:file-size`, existing tests
- [x] T017 Slot: cargo check/clippy/test, `pnpm ci:local`, live check; five-reviewer gate; PR
