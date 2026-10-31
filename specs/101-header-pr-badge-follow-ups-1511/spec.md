# Spec 101: Header PR badge follow-ups (#1511)

## Summary

Deferred Mediums and Lows from the spec 094 gate (#1315). Decisions are the 2026-10-31 "Decided (Skippy, delegated by Stuart)" comment on #1511.

## Decisions

1. Clickable-badge redesign: skipped. The header PR state pill uses a new `subtle` `StatePill` variant.
2. The pinned panels note "From another session" when the pinned item was opened from a different Session than the active one.
3. One shared pinned-panel shell (`components/PinnedPanelShell.tsx`) with `InlineStatus` empty states at `compact` density, used by both panels.
4. One named container breakpoint (`@max-chat-narrow/chat`) and one shared compact header button replace the hardcoded `@max-[42rem]/chat`.
5. The PR state pill loses its extra tab stop; the state and checks icons get `forced-colors` fallbacks.
6. `focus-visible:ring-focus-glow` is measured at 3:1 or better; `InlineStatus tone="error"` announces (already `role="alert"`).
7. The stale `LinkedIssueControls` comment is reworded.
8. Code: check display map moves out of `PullRequestRow` with the `CHECKS_TO_DISPLAY` remap dropped; `HeaderPrControls` uses primitive selectors, clears the live state in a layout effect and drops stale panel responses with a request token; `[data-right-pane-content]` is one shared constant.
9. Backend: a 60 s negative cache for repeated `Unavailable` lookups per repo and branch; a failing `gh` logs at warn level (result stays `Unavailable`); the PR `url` is capped at 2048 characters and must be https; the opener element stays in the store with a why-comment.
10. A closed or merged PR shows when none is open (already so, spec 094). An unknown issue state maps to `unknown`, never `open`.
11. Older fake `gh` scripts move to the new GraphQL shape.

## Out of scope

Lane #1501 files: `PullRequestDetail.tsx`, the issue detail header, `ManageSessionsToolbar.tsx`, `IssueList`, `ProjectListPane`, `CopyButton`, `IconButton`, `OpenOnGitHubButton`, `components/ui/select`, `NewSessionDialog.tsx`, `docs/design/components.md`.
