# Tasks: Chat user avatar

Spec: `spec.md`. Plan: `plan.md`. No new tests (prototyping phase). Commit and push after every task. No cargo or tauri command until the director grants the build slot.

- [x] T1 `avatar.tsx`: `xs` size and forced-colors ring (FR-006).
- [x] T2 Shared `components/UserAvatar.tsx` (FR-001, FR-002, FR-006).
- [x] T3 `useRepositoryAvatarUrl` selector (FR-003, FR-004).
- [x] T4 Thread `userAvatarUrl` through `Transcript.tsx` and `TranscriptRow.tsx` (FR-004).
- [x] T5 `UserMessageRow.tsx` and `AskQuestionRow` render `UserAvatar`; remove the ad hoc circle (FR-001, FR-002, FR-005).
- [x] T6 `docs/design/components.md` and `docs/PLAN.md` row; `check:file-size`, `check:ui-text`, typecheck and existing vitest pass (FR-007).
