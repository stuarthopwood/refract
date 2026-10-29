# Feature Specification: Pull requests (wave 2)

**Feature Branch**: `pull-requests-wave2-bundle`
**Status**: Draft
**Input**: One PR for the wave 2 "Pull requests" bundle in `docs/PLAN.md` (epic #1273): #915 (Timeline restyle, with its second-round amendment), #1196 (rich comment editor, ghost Reply toggles) and #1198 (Checks section). Decisions: the issues' own grill amendments plus the 2026-10-29 wave 2 Pull requests grill (a comment on each issue; glossary terms History line, Author kind, PR image, Markdown editor and Checks section in `CONTEXT.md`; ADR 0004). Numbered 038 (030 to 036 are taken; the composer lane may take 034 or 037). Builds on spec 003 (pull request management).

## Clarifications

### Session 2026-10-29

- Q: Where does the composer-styled field come from, since #675 has not landed and the composer lane owns `MessageInput.tsx`? -> A: A new shared Markdown editor in `src/renderer/components/` using the composer's tokens; `MessageInput.tsx` is not edited.
- Q: Is all of #915 in scope (tables, images, datetime tooltips)? -> A: Yes, including the allow-listed backend image fetch (ADR 0004).
- Q: Image hosts? -> A: A fixed list of GitHub's own hosts. Settings-added hosts are #1314.
- Q: Which editor sizes? -> A: Full size at the bottom (Close pull request and Comment); compact size for thread replies behind a ghost Reply toggle, no Close.
- Q: "Author" badge for the pull request's author? -> A: No. Own comments get "You"; bots get "Bot".
- Q: Close pull request confirmation? -> A: A confirmation naming the pull request, like Merge and Review (a **Review action**).
- Q: Re-run for checks? -> A: Not in v1.

## User Scenarios and Testing

### US1 - Read the Timeline like GitHub's (P1, #915)
I open a pull request and see a thin history line down the left. Commits are single unboxed rows on it (icon, headline, short SHA, time), grouped as "N commits" when consecutive. Comments, reviews and threads are soft-bordered cards with the author's avatar and login, a "Bot" badge for bots, an accent-tinted header and "You" badge for my own, and "edited" when edited. Hovering or focusing a relative time shows the full local date.
- **Independent test**: open a PR with commits, a bot comment, my own comment and an edited comment; each shows as described.

### US2 - Markdown that renders (P1, #915)
`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` and `[!CAUTION]` render as alerts, everywhere the shared Markdown renders (chat too). Tables size to content with cell borders; links take the link colour. In the Pull requests view, images from GitHub hosts show inline; elsewhere images stay alt-text links.
- **Independent test**: a PR whose body has an alert, a table and a GitHub-hosted image.

### US3 - Reply and comment with a real editor (P1, #1196)
Each thread has a ghost Reply button that opens a compact editor under the thread with focus in it; Ctrl+Enter sends, Esc or Cancel closes and keeps the draft. The bottom comment box is the full editor: Write/Preview, a toolbar (Heading, Bold, Italic, Quote, Code, Link, Bulleted, Numbered, Task list), Ctrl+B/I/K, and under it "Close pull request" (outlined destructive, confirmation) and "Comment" (primary).
- **Independent test**: open and close a Reply, reopen to see the draft, send; format a selection with the toolbar; close a scratch PR.

### US4 - See which check failed (P1, #1198)
A Checks section after the Timeline lists checks grouped by outcome with the overall state in its header; failing groups open, the rest collapsed with counts; each row has icon plus word, name, duration and an "Open details" menu.
- **Independent test**: a PR with mixed outcomes; the poll refreshes a pending check.

### Edge cases
- A commit message with trailers shows only its first line. A PR with no checks hides the section. An avatar or image fetch failure falls back to initials or the alt-text link. An image from a non-allow-listed host, or any image in chat, keeps the alt-text link. An unknown alert marker stays a plain quote. A draft survives closing a reply field but not leaving the PR.

## Requirements

- **FR-001** The Timeline has a 1px `--divider` history line (decorative, `aria-hidden`); commits are unboxed rows (icon, first-line headline, monospace short SHA, relative time), consecutive commits grouped under "N commits"; every entry stays a list item.
- **FR-002** Cards use the soft `--divider` border, not `border-border`.
- **FR-003** Every card header shows the author's avatar (backend fetch, `data:` URL) and login; a bot (`__typename` `Bot`) gets a muted "Bot" badge; the signed-in developer's own cards get an accent-tinted header and a "You" badge; "edited" shows when the comment was edited. The GraphQL query adds `__typename`, the avatar URL and `lastEditedAt`.
- **FR-004** The shared `Markdown` renders the five GitHub alerts with a coloured left bar, icon and text title, using new per-theme tokens that pass `check:theme-contrast`.
- **FR-005** In the Pull requests view, Markdown tables size to content with GitHub-style cell borders on `--divider`, and links take the link colour.
- **FR-006** A **PR image** is fetched by the backend (https only, GitHub image hosts, no automatic redirects with each hop re-checked, png/jpeg/gif/webp only, byte cap, timeout) and returned as a `data:` URL; only the Pull requests view requests it. No CSP change (ADR 0004).
- **FR-007** Every relative time in the Pull requests view (list rows and timeline cards) is a `<time datetime>` with a shared Tooltip showing the full local date and time, on hover and keyboard focus.
- **FR-008** A shared **Markdown editor** component with a Write/Preview toggle (Preview through `Markdown`), the nine-button toolbar (each wraps the selection or inserts at the line start) and Ctrl+B, Ctrl+I, Ctrl+K, in a full and a compact size, built on the composer's tokens, without editing `MessageInput.tsx`.
- **FR-009** Each thread shows ghost Reply (accessible name "Reply to path:line", `aria-expanded`) beside Resolve; opening moves focus into a compact editor; Ctrl+Enter sends through `replyToThread` and closes on success; Esc or Cancel closes, keeps the draft and returns focus to Reply.
- **FR-010** The bottom comment box is the full editor with "Comment" (primary) and "Close pull request" (outlined destructive; shown only while the PR is open; confirmation naming the PR; new Rust `close_pull_request` mutation and IPC, a **Review action**).
- **FR-011** A Checks section after the Timeline and before the comment box (hidden with no checks): header with the overall state; groups Action required and Failing (expanded), Pending, then Successful, Neutral and Skipped (collapsed, with counts); rows with the #1120 RAG status icon plus word, name, duration and a row menu "Open details" through the existing http(s)-only external-link path.
- **FR-012** Each `statusCheckRollup` entry (name, status/conclusion, startedAt, completedAt, detailsUrl) reaches the renderer; the section refreshes with the existing pending-check poll.
- **FR-013** WCAG 2.1 AA: group headers are buttons with `aria-expanded`; state is text plus icon; alerts expose their title as text; the history line is hidden from assistive technology; the toolbar is a labelled toolbar with arrow-key roving focus.
- **FR-014** `Timeline.tsx` and `PullRequestDetail.tsx` stay under the 600-line cap (new components `ThreadReply.tsx`, `ChecksSection.tsx`, `TimelineCards.tsx` and shared pieces take the code); no new tests; existing tests stay green.

## Out of scope
User-added image hosts (#1314); reactions (#1199); re-run checks; Author badge; editing `MessageInput.tsx` or adopting the editor in the chat composer.

## Success criteria
`pnpm ci:local` passes (all 17 steps); a live check on a scratch exe shows US1 to US4 against a real PR with mixed content; five-reviewer gate PASS.
