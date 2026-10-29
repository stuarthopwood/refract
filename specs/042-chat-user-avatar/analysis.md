# Analysis: Chat user avatar

FR-001 to FR-007 map to T1 to T6; no uncovered requirement. Risks:
- `RequestCard.tsx` is 596 of 600 lines: the change replaces a 6-line span with a one-line component, so it shrinks.
- `Transcript.tsx` is 967 lines against baseline 1059: one hook call and one prop only.
- `TranscriptRow` is memoised: `userAvatarUrl` must join its comparison or a photo change never repaints.
- `remote` loads after `repositories.list()` (issue #528), so the photo may appear a moment after first paint; the initials show meanwhile, in the same fixed-size box, so nothing shifts.
- The bubble avatar changes from a line-height pill to a 32 px circle: spacing, narrow panes and the footer offset are checked live.
