# Feature Specification: Composer `#` picker for issue and PR references

**Feature Branch**: `feat/1789-hash-picker`
**Created**: 2026-11-10
**Status**: Draft
**Input**: GitHub issue #1789 (grilled with Stuart 2026-11-10; no triage comment existed on the issue, so the Spec Kit route was chosen here). Route: specify (new spec 123). Pairs with #1155 (rendering and hover card of the inserted reference), which is on origin/main.

## Problem
To reference a pull request or issue the developer must know its number or leave Refract to look it up. GitHub, VS Code and Copilot Chat all offer a `#` picker; the composer does not. #1155 already renders `#123` in a sent message as a link with a hover Item card, so only the insertion side is missing.

## Clarifications

### Session 2026-11-10 (from grill, Stuart, final)
- Q: Which repositories does the picker search? -> A: Only the Session's Project GitHub repository. With no GitHub repository on the Project, `#` types normally and no picker opens. `owner/repo#` is out of scope.
- Q: How many results, and paging? -> A: The top 10 issues and pull requests together. Typing narrows them; there is no paging and no scrolling past 10.
- Q: When does `#` open the picker? -> A: Only at the start of the text or after whitespace, decided from the text before the caret. Never mid-word, inside inline code, or inside a code fence.
- Q: What does choosing an item insert? -> A: `#N ` (the number and one space), which #1155 renders as a link and hover card. No results shows "No matching items". A failed search shows an inline error and leaves the typed `#` text alone.
- Q: Build order against open PR #1837 (also edits `MessageInput.tsx` and `useSlashMenuCompletion.ts`)? -> A: Start now, not stacked. `MessageInput.tsx` gains only a hook call, key routing and one mount; the logic lives in a new hook and component so a later merge is easy.

### Decided while specifying (Skippy, under Stuart's delegation)
- The query ends at whitespace: `#fix login` closes the picker at the space. A query that allowed spaces would reopen the picker over the `#123 ` it has just inserted.
- The GitHub search API cannot match a number prefix. A digits-only query therefore also looks up that exact number, pins that item first, then lists title matches (10 in total).
- Query characters are reduced to letters, digits, `.`, `_` and `-` in the backend before the query reaches `gh`, so a typed `repo:other/x` or `is:` cannot widen or redirect the search to another repository.
- The empty query (`#` alone) lists open items, newest updated first. A typed query searches titles of open and closed items.

## User Scenarios & Testing

### User Story 1 - Find and insert a reference without leaving the composer (Priority: P1)
**Acceptance Scenarios**:
1. **Given** a Session whose Project has a GitHub repository, **When** I type `#` at the start of the message or after a space, **Then** a picker opens above the composer listing up to 10 recent open pull requests and issues, each row with a state icon and word, `#number` and title.
2. **Given** the picker is open, **When** I keep typing, **Then** the list narrows to matches (digits match that number; text matches titles, open and closed).
3. **Given** the picker is open, **When** I press Down or Up, **Then** the selection moves; **When** I press Enter or Tab (or click a row), **Then** the typed `#query` is replaced by `#<number> ` and the caret sits after the space; Enter does not send the message.
4. **Given** the picker is open, **When** I press Escape, **Then** it closes and the typed text stays; typing again reopens it.
5. **When** I send the message, **Then** the reference renders as a link with the #1155 hover card.

### User Story 2 - The picker stays out of the way (Priority: P1)
**Acceptance Scenarios**:
1. **Given** a `#` inside a word (`abc#1`), inline code (`` `#1 ``) or a fenced code block, **Then** no picker opens.
2. **Given** a Project with no GitHub repository, **Then** `#` types normally and no picker opens.
3. **Given** the caret is moved away from the `#query`, **Then** the picker closes.

### User Story 3 - Slow, empty and failed searches say so (Priority: P2)
**Acceptance Scenarios**:
1. While a search runs, the picker shows a loading row.
2. With no match, it shows "No matching items".
3. If the search fails (offline, `gh` signed out), it shows an inline error and the typed `#` text is untouched.
4. A response for an older query never replaces the results of a newer one.

## Requirements

### Functional Requirements
- **FR-001**: The trigger is a `#` at the start of the text or after whitespace, with the caret directly after `#` or after `#` plus non-whitespace characters, decided from the text before the caret. The caret must be collapsed (no selection).
- **FR-002**: No trigger inside inline code or a fenced code block on the text before the caret, or when the Project has no GitHub repository.
- **FR-003**: The renderer debounces searches, drops stale responses, and bounds the query length.
- **FR-004**: A new IPC `itemRefs.search(repositoryId, query)` returns at most 10 items `{ number, kind, title, state, draft }` for the Project's repository only. The backend validates the repository slug, reduces the query to safe characters, runs one bounded `gh api search/issues` call (15 s timeout) and, for a digits-only query, one exact lookup.
- **FR-005**: The picker is a combobox and listbox (`role="combobox"` on the composer, `aria-expanded`, `aria-controls`, `aria-activedescendant`), operable by keyboard (Up, Down, Enter, Tab, Escape), with a polite live region announcing the result count, "No matching items", and errors. State is an icon plus a word, never colour alone.
- **FR-006**: Choosing an item replaces the typed `#query` with `#<number> ` and moves the caret after the space.
- **FR-007**: The picker reuses the slash menu's popover and option styling rather than adding a second look.
- **FR-008**: The slash menu is unchanged: a draft that starts with `/` keeps the slash menu, and only one menu shows at a time.

## Out of Scope
Cross-repository search, paging, Markdown-link inserts, any #1837 change, a picker in other inputs.

## Success Criteria
- **SC-001**: In a live Refract, typing `#` in a Session of a GitHub Project opens the picker, typing narrows it, Enter inserts `#N `, and the sent message shows the #1155 link.
- **SC-002**: `pnpm ci:local` passes (Rust tests for query building and parsing included).

## Known evidence gaps
Rust is compiled and the live check is run later, after the build slot frees; this PR is a draft until then.
