# Plan: Chat user avatar

Spec: `spec.md`. One PR, one worker.

1. `components/ui/avatar.tsx`: add `xs` size (`data-[size=xs]:size-5`, fallback `text-badge`), and `forced-colors:after:mix-blend-normal` so the ring survives forced colours.
2. `components/UserAvatar.tsx` (new, shared): `{ name, src?, size?, className? }` renders `Avatar` + `AvatarImage` (`alt=""`) + `AvatarFallback` (initials of `name`), `aria-hidden`.
3. `features/chat/useUserAvatarUrl.ts` (new): `useRepositoryAvatarUrl(repositoryId)` selects from `useRepositoriesStore` and `useAccountsStore`, returns `string | undefined` (primitive).
4. `Transcript.tsx` reads the hook next to `useRepositoryUserName` and passes `userAvatarUrl` through `TranscriptRow` (memo comparison updated) to `UserMessageRow` and `AskQuestionRow`.
5. `UserMessageRow.tsx` and `RequestCard.tsx` render `UserAvatar`; `MessageAvatar` stays as the layout slot (`self-end`, footer offset) around it.
6. `docs/design/components.md`: document `UserAvatar`. `docs/PLAN.md`: #505 status.

Shared files touched: `Transcript.tsx` (a hook call and one prop), `TranscriptRow.tsx` (one prop), `RequestCard.tsx` (shrinks), `avatar.tsx`, `docs/PLAN.md`, `docs/design/components.md`. Rust is not touched. Build slot: no cargo/tauri/ci:local until the director grants it.
