# Implementation Plan: Pull requests (wave 2)

**Spec**: `specs/038-pull-requests-wave2/spec.md` | **Branch**: `pull-requests-wave2-bundle`

## Technical context
Tauri v2 Rust backend (`src-tauri/`), React renderer (`src/renderer`), shared types in `src/shared`, IPC bridge `src/tauri-bridge/index.ts`. Constitution Principle V (Tauri security baseline) binds; ADR 0003 (reusable components) and ADR 0004 (PR images) apply. No new tests (prototyping rule); existing tests stay green. Heavy builds only in the director's build slot.

## Work packages
**WP1: Rust backend and shared types** (owns `src-tauri/src/github/**`, `src-tauri/src/ipc/pull_requests/**`, `src/shared/github.ts`, `src/shared/ipc.ts`, `src/tauri-bridge/index.ts`)
- `gh_mutations.rs`: `THREADS_AND_TIMELINE_QUERY` adds `__typename`, `avatarUrl` and `lastEditedAt` to every `author`/comment; new `close_pull_request` mutation (`gh pr close`-equivalent GraphQL `closePullRequest`).
- `gh_pull_requests.rs`: map each `statusCheckRollup` entry (name, status, conclusion, startedAt, completedAt, detailsUrl) into `PullRequestDetail.checks`; keep the aggregate `checkState`.
- New `github/images.rs`: `fetch_pr_image(url)`, modelled on `profile.rs::fetch_avatar` (https, host allow-list `avatars.githubusercontent.com`, `user-images.githubusercontent.com`, `private-user-images.githubusercontent.com`, `github.com` attachment paths and `raw.githubusercontent.com`, no auto redirects, each hop re-validated, png/jpeg/gif/webp only, byte cap, timeout). IPC `pullRequests.fetchImage(url)` and `pullRequests.close(repositoryId, number)`; avatars use the same fetch (author `avatarUrl` is already on the allow-list).
- Types: `PullRequestActor` gains `kind: 'user' | 'bot'` and `avatarUrl`; timeline comment/review/thread-comment gain `edited: boolean`; `PullRequestDetail` gains `checks: PullRequestCheck[]` and `viewerLogin`.

**WP2: Shared renderer pieces** (owns `src/renderer/components/**` additions, `src/renderer/features/chat/Markdown.tsx`, `globals.css` and theme token files, `scripts/check-theme-contrast*` inputs)
- `Markdown.tsx`: GitHub alerts (blockquote first line `[!KIND]`), alert tokens per theme; table sizing and cell borders and link colour behind a `variant="github"`-style prop used by the Pull requests view only; image rendering through an optional `resolveImage` prop (Pull requests view passes it; chat does not).
- New shared `components/relative-time.tsx` (`<time datetime>` + Tooltip with full local date).
- New shared `components/markdown-editor/` (editor, toolbar, formatting helpers): full and compact sizes, Write/Preview, toolbar, Ctrl+B/I/K, Ctrl+Enter `onSubmit`, Esc `onCancel`, built on composer tokens, not editing `MessageInput.tsx`.

**WP3: Pull requests screens** (owns `src/renderer/features/pull-requests/**`; after WP1 and WP2)
- `Timeline.tsx` split: `TimelineCards.tsx` (history line, commit group rows, cards, author kind header via shared Avatar/Badge, soft borders), `ThreadReply.tsx` (ghost Reply toggle + compact editor + draft).
- `ChecksSection.tsx` (shared Collapsible, Badge, DropdownMenu; reads #1121's `CHECK_STATE_DISPLAY` colours); mounted in `PullRequestDetail.tsx` between Timeline and the comment box.
- `PullRequestDetail.tsx`: bottom box becomes the full Markdown editor with Close pull request (AlertDialog naming the PR) and Comment; keep under the cap by moving the box to `CommentBox.tsx`.
- `PullRequestRow.tsx`/cards: relative times use `RelativeTime`.

## Shared files touched (composer lane overlap)
`src/renderer/features/chat/Markdown.tsx` (additive props and alert branch), `src/renderer/styles/globals.css` and theme files (additive tokens). `MessageInput.tsx` is not touched.

## Verification
`pnpm typecheck` and renderer tests per WP; cargo check/clippy in the slot; `pnpm ci:local` (17 steps) and a live check on a scratch exe against a real PR in the slot; five-reviewer gate.
