# Feature Specification: Chat user avatar

**Feature Branch**: `chat-user-avatar`
**Status**: Draft
**Input**: #505 "Feat: chat: show the user's GitHub avatar on their messages, with initials as the fallback". Numbered 042: 041 is the last taken. Triage routed it as converge on spec 001; it is filed as its own spec because it adds a shared component and a new selector, and amends spec 001 (transcript) and spec 008 (accounts) only by consuming them.

## Clarifications

### Session 2026-10-29 (grill, Skippy delegated by Stuart; recorded on #505)

- Q: Which account supplies the photo? A: the active `GitHubAccount` on the repository's host (`Repository.remote.host`, case-insensitive). No remote, no matching account or no cached photo gives initials.
- Q: Git `user.name` and the account differ? A: the photo follows the account; the name text stays the git name; initials come from the git name.
- Q: Account not in `success` state with a cached photo? A: still show the photo.
- Q: Size? A: bubble avatar is a 32 px circle (`Avatar` default); answered-Ask avatar is 20 px through a new `xs` size on the shared `Avatar`. Fixed box in both states, no `delayMs`.
- Q: Decorative? A: `alt=""` and `aria-hidden`, no tooltip.
- Q: Network and CSP (Principle V)? A: none. The data URL already comes from the accounts store (spec 008); no blob URL, no `?s=64` change, no capability change.
- Q: Queued messages? A: not applicable, they are chips.
- Platform note: the issue cites the Electron `src/main/github/profile.ts`; the equivalent is now `src-tauri/src/ipc/accounts/`, unchanged by this feature.
- Clarify pass (self-answered): no further ambiguity that changes the implementation.

## Requirements

- **FR-001** A user message row shows a round avatar image of the GitHub account chosen by FR-003, at 32 px, aligned to the bubble's last line as today, with the git-name initials as the fallback inside the same shared `Avatar` when there is no remote, no matching account, no cached photo, or the image fails to load.
- **FR-002** The answered Ask line (`AskQuestionRow`) shows the same avatar at 20 px. Both call sites use one shared `UserAvatar` component (over `components/ui/avatar.tsx`, which gains an `xs` size); the ad hoc initials circle in `RequestCard.tsx` is removed.
- **FR-003** A selector returns the photo for repository R: R's `remote` is `has` with a `host`, and the accounts store holds an `active` account with that host (case-insensitive) and a non-null `avatarDataUrl`; otherwise `undefined`. It returns a primitive string so a transcript of many rows re-renders only when the photo itself changes.
- **FR-004** The avatar is derived at display time from the accounts and repositories stores, never stored in the transcript; it updates without reload when the active account, the profile cache or the remote changes.
- **FR-005** The name in the bubble header is unchanged (git name). Agent and subagent messages are unchanged.
- **FR-006** The avatar is decorative (`alt=""`, `aria-hidden`), has no tooltip, keeps the shared ring (visible in forced-colors mode), and the initials fallback keeps 4.5:1 contrast (`bg-muted` on `text-muted-foreground`) in every preset including High contrast.
- **FR-007** No new network, auth, IPC, CSP or capability surface; no Rust change.

## Success criteria

- `pnpm ci:local` is green on the merged tree; the live check on a scratch exe shows the photo and the initials fallback in Dark and High contrast.
- No file grows past its `scripts/file-size-baseline.json` value; `RequestCard.tsx` (596 lines) does not grow; new files stay under 600 lines; reusable components only (ADR 0003).
- No new tests (prototyping phase); existing tests keep passing.
