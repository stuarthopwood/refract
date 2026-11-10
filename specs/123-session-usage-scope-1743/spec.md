# Feature Specification: Session usage panel scope and range toggles

**Feature Branch**: `feat/1743-usage-scope`
**Created**: 2026-11-09
**Status**: Draft
**Input**: GitHub issue #1743 (`p1`, `design`), decided by Stuart 2026-11-06 and grilled before this lane (outcomes below and in `docs/PLAN.md` line 1117).

## Clarifications

### Session 2026-11-09

Answers come from the issue body, the grill with Stuart, and the code on origin/main. Recorded from the grill.

- Q: What happens to the Conversation option when the focused Session has no Conversation (`currentConversation` is null)? -> A: The Conversation option is disabled, and the panel shows Session figures. The stored choice is kept, so it applies again once a Conversation exists. (from grill)
- Q: How does Today match the Usage view? -> A: Range Today sends `range: 'today'` with the same time-zone offset the Usage view sends (`new Date().getTimezoneOffset()`, minutes west of UTC), so Session plus Today totals equal the Usage view's today figures for that Session. (from grill)
- Q: Where are the choices stored? -> A: In the existing `usage.setPrefs` / `usage.getPrefs` `prefs` table, as two new allowlisted keys `sessionScope` (`session` or `conversation`) and `sessionRange` (`all` or `today`). No new store, no new channel. (from grill)
- Q: Which control? -> A: The shared segmented `ToggleGroup` (`components/ui/toggle-group.tsx`), one group per toggle, at the top of the panel body. Both are keyboard operable. (from grill, ADR 0003)
- Q: What does Conversation filter on? -> A: The Session's current Conversation file (`Session.currentConversation`), matched against the stored `session_file` with the same separator and ASCII-case folding as the `sessionDir` match. New `sessionFile` filter beside `sessionDir`, in `UsageFilters` and the Rust `Filters`. (issue)
- Q: Does the credit-budget share line follow the toggles? -> A: Scope follows; range does not. It is always the spend in the scope since the current Copilot credit period began, because a share of a monthly budget over "today" is meaningless. Not in the grill; chosen for consistency. Stuart can overrule.
- Q: Does the spend chart change for Today? -> A: Yes, it buckets by hour, since one day is a single bar. Not in the grill; chosen. Stuart can overrule.
- Q: Empty text? -> A: "No usage yet in this session" becomes "No usage {yet|today} in this {session|conversation}". Not in the grill; chosen.
- Q: Defaults when nothing is stored (or the stored value is no longer allowed)? -> A: Session and All time, today's behaviour.
- Q: Open questions in the issue? -> A: None.

## User Scenarios & Testing

### User Story 1 - See what the current Conversation cost (Priority: P1)

**Independent Test**: In a Session with two Conversation files, switch scope; spend and calls drop to the focused Conversation's figures, and Session shows the sum.

**Acceptance Scenarios**:

1. **Given** a Session with several Conversations, **When** Conversation is chosen, **Then** every figure in the panel counts only the focused Conversation's file.
2. **Given** a Session with no Conversation yet, **Then** the Conversation option is disabled and Session figures show.
3. **Given** a new Conversation starts in the Session while Conversation is chosen, **Then** the figures follow it.

### User Story 2 - Match the Usage view for today (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a Session spanning days, **When** Today is chosen, **Then** its spend equals the Usage view's today total filtered to that Session.
2. **Given** All time, **Then** figures are unchanged from before this change.

### User Story 3 - Choices persist (Priority: P2)

**Acceptance Scenarios**:

1. **Given** Conversation and Today are chosen, **When** the app restarts, **Then** the panel opens with both still chosen.
2. **Given** keyboard only, **Then** Tab reaches each toggle and the arrow keys change the choice.

### Edge Cases

- Re-pressing the selected segment does nothing (one option is always chosen).
- Switching Sessions keeps the toggles (they are panel-wide), and each scope/range/Session combination has its own cached result, so one never shows another's figures.
- Hostile or unknown `sessionFile`, `sessionScope`, `sessionRange` values are rejected or bound, never spliced into SQL; an empty `sessionFile` is rejected.

## Requirements

- **FR-001**: `UsageFilters` gains `sessionFile?: string | null`; Rust `Filters` gains `session_file`, matched exactly after folding as `sessionDir` is, in every query that honours `sessionDir`; a Conversation filter reads the per-call rows like a Session filter does.
- **FR-002**: `UsagePrefs` gains `sessionScope` and `sessionRange`; `usage.setPrefs` accepts them and rejects values outside the allowlists; `usage.getPrefs` returns the stored value or the default.
- **FR-003**: The panel shows two toggle groups (Session / Conversation, All time / Today) built on the shared `ToggleGroup`, each with an accessible name.
- **FR-004**: Today uses `range: 'today'` and the Usage view's offset.
- **FR-005**: Conversation is disabled and Session figures show when the Session has no Conversation file.
- **FR-006**: Results are cached per Session directory, Conversation file (when in effect) and range.
- **FR-007**: No file exceeds 600 lines.

## Success Criteria

- Session plus Today equals the Usage view's today total for that Session; Conversation figures are a subset of Session figures; both choices survive a restart.
- A Rust test covers the `sessionFile` match (folded separators and case, one file only), `today` with the filter, and rejection of an empty value.

## Assumptions and non-goals

- Prototyping phase: no new TypeScript tests; one Rust test is added; all existing tests stay green.
- Not changing the Usage view, its filters, or the dashboard's persisted `filters` pref.
