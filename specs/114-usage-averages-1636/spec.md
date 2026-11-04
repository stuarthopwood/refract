# Feature Specification: Usage view Averages section

**Feature Branch**: `feat/1636-usage-averages`
**Created**: 2026-11-04
**Status**: Draft
**Input**: GitHub issue #1636 (`p1`, `enhancement`), grilled with Stuart 2026-11-03 (outcomes in the issue body and `docs/PLAN.md` line 1063).

## Clarifications

### Session 2026-11-04

All answers come from the issue's grill block, its "Intended behaviour" section, `docs/PLAN.md` line 1063, and the code on origin/main. Recorded 2026-11-04 from grill.

- Q: Which averages? -> A: Avg spend per day, Avg credits per day, Avg calls per day, Avg spend per call, Avg spend per Session, Projected month spend. (from grill)
- Q: What does "per day" divide by? -> A: Active days: local calendar days in the range with at least one model call. The day boundary is the spend chart's day bucket (`((hour + offset) / 86400000)`, exact rows in half-hour zones, as `timeseries`). (from grill)
- Q: Where do they sit? -> A: A new `ScreenSection title="Averages"` directly under the headline cards in `UsageView`, same `grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4` grid and `StatCard`. The headline row stays at eight cards. New file `AverageCards.tsx`; `HeadlineCards` does not grow. (from grill)
- Q: What does the Session usage panel get? -> A: Its stacked muted line becomes "Cache hit rate X · Tool error rate Y · Avg spend per call Z". No other averages there. (from grill)
- Q: Who computes what? -> A: Rust `summary` returns the counts so every filter applies; the renderer only divides and formats. (from grill)
- Q: How is the projection worked out? -> A: month-to-date spend + (month-to-date spend / month active days) x weekdays (Monday to Friday) left in the month after today. It always covers the current local calendar month and ignores the date range; Project, model, reasoning, agent-type (and Session) filters apply. Caption "This month, ignores the date range". Before any spend this month it shows `-`. (from grill)
- Q: Where is `weekdaysLeft` computed? -> A: In the renderer from today's local date (a pure helper); the query does not return it. (from grill)
- Q: Zero denominators? -> A: `-` with an accessible name (existing empty-value convention, else `aria-label="No data"`). (from grill)
- Q: Captions? -> A: Per-day cards say "Over N active days"; credits adds "Copilot models only"; no jokes for averages. (from grill)
- Q: What is a "Session" for `sessions`? -> A: A distinct `session_file` (conversation file) with at least one model call, the same unit as the Top sessions table and the Session filter. Subagent and advisor files each count, unless the agent-type filter excludes them. Not in the grill; chosen for consistency. Stuart can overrule.
- Q: Precision of Avg spend per call? -> A: Under $1 shows three decimals (`$0.042`); $1 and over shows two. Not in the grill; chosen to meet the issue's `$0.042` example. `formatUsd` is unchanged.
- Q: Open questions in the issue? -> A: None.

## User Scenarios & Testing

### User Story 1 - See what a typical day and Session costs (Priority: P1)

A user opens the Usage view and sees an Averages section under the headline cards with per-day spend, credits and calls, spend per call and per Session.

**Independent Test**: With seeded usage, compare each average by hand against the totals for 7d and All time.

**Acceptance Scenarios**:

1. **Given** usage across N active days, **When** the view loads, **Then** Avg spend per day = Spend / N and its caption reads "Over N active days".
2. **Given** a Project filter, **When** it changes, **Then** active days, Sessions and all averages follow it.
3. **Given** no model calls in range, **When** the view shows, **Then** each average shows `-` with an accessible name, with no divide-by-zero.

### User Story 2 - See where the month is heading (Priority: P1)

**Acceptance Scenarios**:

1. **Given** spend this month, **When** the date range changes, **Then** Projected month spend does not change while the other averages do.
2. **Given** a model, reasoning, agent-type or Project filter, **When** it changes, **Then** the projection changes.
3. **Given** no spend this month, **Then** the projection shows `-`.
4. **Given** today is the last weekday of the month or later, **Then** weekdays left is 0 and the projection equals month-to-date spend.

### User Story 3 - Spend per call in the Session usage panel (Priority: P2)

**Acceptance Scenarios**:

1. **Given** the Session usage panel, **Then** its muted line reads "Cache hit rate X · Tool error rate Y · Avg spend per call Z", and `-` for Z with zero calls.

### Edge Cases

- Half-hour time zones: day buckets read exact rows, as the spend chart does.
- A call at 23:30 and 00:30 local counts as two active days.
- `today` range: one active day at most.
- A month boundary during a session: month fields use the clock at query time.

## Requirements

- **FR-001**: `usage.summary` adds `activeDays`, `sessions`, `monthToDateUsd`, `monthActiveDays` (camelCase), all under the request's filters; month fields ignore only the date range.
- **FR-002**: `activeDays` uses the spend chart's local day bucket.
- **FR-003**: The renderer computes the six averages, shows `-` for a zero denominator, and computes `weekdaysLeft`.
- **FR-004**: `AverageCards.tsx` renders the Averages `ScreenSection` with `StatCard`s in the existing grid; headline row unchanged at eight cards.
- **FR-005**: The Session usage panel's stacked line gains "Avg spend per call".
- **FR-006**: Captions per Clarifications; no jokes.
- **FR-007**: Accessibility: `StatCard` labels each value; `-` has an accessible name; captions keep 4.5:1 contrast.
- **FR-008**: No file exceeds 600 lines; `queries.rs` (597 lines) must shrink to take the new code.

## Success Criteria

- Hand-computed averages match for 7d and All time; the projection is unchanged across date ranges and changes with Project.
- Rust test extension covers `active_days`, `sessions`, the month fields and filters.

## Assumptions and non-goals

- Prototyping phase: no new tests are added; the existing `summary_and_calls_read_what_was_recorded` is extended (issue verification rule) and all existing tests stay green.
- Not changing the spend chart, headline cards, Project filter or `ProjectIndex` (#1571 follows this).
