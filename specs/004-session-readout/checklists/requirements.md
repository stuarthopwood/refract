# Specification Quality Checklist: Session readout

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-02
**Feature**: [spec.md](../spec.md)

**Review Ownership**: This checklist is a reviewer-owned requirements-quality review artifact.
Mark an item `[x]` only when the reviewer determines the requirements-quality criterion is
satisfied. `[x]` does not mean implementation work is complete.

## Content Quality

- [x] CHK001 No implementation detail (language, framework, API) leaks into a requirement —
      verified: FRs name readouts, chips, and screens, never a component library, IPC channel, or
      OMP frame name.
- [x] CHK002 Focused on user value, not a technical mechanism — verified: every FR is phrased as
      what the developer sees or can do, not how it is computed.
- [x] CHK003 Written so a non-technical stakeholder can follow it — verified: no jargon beyond
      the shared vocabulary in CONTEXT.md ("Session", "Approval mode").
- [x] CHK004 All mandatory sections are present (User Scenarios, Requirements, Success Criteria) —
      verified.

## Requirement Completeness

- [x] CHK005 No `[NEEDS CLARIFICATION]` marker remains — verified: the two open items in
      Assumptions (the "Artifacts" chip, the turn-timer-plus-clock reading) are explicitly framed
      as out-of-scope or as reasonable interpretations to confirm later, not blocking markers.
- [x] CHK006 Every requirement is testable and unambiguous — verified against each FR's
      Acceptance Scenario; see the Coverage Summary below for the FR-to-scenario mapping.
- [x] CHK007 Every Success Criterion is measurable and technology-agnostic — verified: SC-001 to
      SC-008 each name a concrete time bound, a percentage, or a 100%-of-the-time guarantee, with
      no implementation detail.
- [x] CHK008 Every acceptance scenario is in Given/When/Then form — verified across all three user
      stories (11 + 5 + 4 scenarios).
- [x] CHK009 Edge cases are identified for every requirement that has one — verified: 12 edge
      cases, each traced to the FR it qualifies (see Notes).
- [x] CHK010 Scope is clearly bounded — verified: Assumptions names what is explicitly out (the
      "Artifacts" chip, other OMP statistics, the right pane's other planned content).
- [x] CHK011 Dependencies and assumptions are identified — verified: Assumptions names the
      dependency on spec 003 (Pull request chip's destination), spec 001 FR-039/FR-041 (Changes
      figure, the existing model/effort readout this spec does not duplicate), and the two
      constitution-IV unverified-OMP-behaviour notes (Context window usage, Subagents).

## Requirement Clarity and Consistency

- [x] CHK012 No vague adjective lacks a measurable criterion — checked "large" (FR-002: resolved
      by "shown abbreviated", with a worked example "1.2k"), "nears the window's limit" (FR-003:
      qualified by SC-005's "across its full range from first appearance to full" and the never-
      colour-alone rule), "live" (FR-008: qualified by the per-chip hidden/retain rules in the
      same FR and the edge cases).
- [x] CHK013 No requirement conflicts with another — checked FR-007 (chip count: "running or
      finished") against FR-017 (panel: "running, finished, or failed") for a terminology clash;
      this is an intentional difference in scope (chip excludes failed, panel includes it), not a
      contradiction — flagged for the implementer in research.md so it is not accidentally
      conflated.
- [x] CHK014 Terminology is consistent with CONTEXT.md — verified: "Session", "Approval mode",
      "Conversation" are used exactly as defined there; no new term needed updating in CONTEXT.md
      from this spec's own text (the implementer's docs task may still add "Readout chip" and
      "Subagent panel" as new vocabulary once built).
- [x] CHK015 Every cross-spec reference is explicit about what is depended on, not assumed —
      verified: FR-006 names spec 003 specifically for the Pull request chip's destination; FR-011
      names spec 008 specifically for the Settings entry point; FR-002 and the Assumptions name
      spec 001 FR-039/FR-041 specifically, rather than a bare "the rest of the app".

## Acceptance Criteria and Scenario Coverage

- [x] CHK016 Every readout kind in FR-001's list has at least one acceptance scenario covering
      its shown state and its hidden/unavailable state — verified: Changes (AC1, AC2 via edge
      case), Context window usage (AC3, AC4), Turn time (AC6, AC7), Current time (AC8), Pull
      request (AC9, plus the no-remote/lookup-failure edge cases), Subagents (AC10), Todo progress
      (AC11).
- [x] CHK017 Every disabling/hiding condition named in an FR has a matching edge case or
      acceptance scenario — verified against the Edge Cases section (12 items, each citing the
      condition it covers).
- [x] CHK018 Keyboard operability and non-colour-alone status are each asserted as their own
      testable requirement, not folded silently into a UI description — verified: FR-010 (chip
      row), FR-016 (Settings), FR-029-equivalent not applicable here (that FR number belongs to
      spec 003); each story's own acceptance scenarios also exercise keyboard-only operation
      (US1/AC10 equivalent via FR-010, US2/AC5, US3 is pointer-described but FR-017's "activate"
      wording does not preclude a keyboard activation, consistent with FR-010).

## Non-Functional and Dependency Coverage

- [x] CHK019 Performance/timing success criteria exist for every live-updating surface —
      verified: SC-001 (chip row), SC-002 (Settings propagation), SC-006 (subagent panel and
      stream); no numeric criterion is missing for a live surface the FRs describe.
- [x] CHK020 The spec names every constitution-IV "evidence before design" gap it depends on,
      rather than silently assuming an unverified OMP behaviour — verified: the Assumptions
      section explicitly calls out Context window usage and Subagents as unverified on the supported
      OMP versions (18.4.x/18.5.x) and requires a `docs/spike/FINDINGS.md` record before a plan
      relies on them; Todo progress's source is similarly flagged as unverified in the same section.
- [x] CHK021 Out-of-scope items are distinguished from deferred [NEEDS CLARIFICATION] items —
      verified: the "Artifacts" chip and "other OMP statistics" are explicitly marked as dropped/
      candidates-for-later, not blocking questions.

## Notes

- Validation pass 1 (2026-10-02): all items pass; no spec wording was changed. The spec's own
  Assumptions section already self-identifies its three constitution-IV gaps and its two cross-
  spec dependencies, which is unusually thorough for a Draft spec and needed no addition here.
- CHK013's flagged FR-007/FR-017 scoping difference (chip excludes `failed`, panel includes it) is
  intentional per the spec's own literal wording in both FRs; it is called out again in this
  spec's research.md (decision 9) so an implementer does not quietly unify the two counts.
- Edge case "The agent is not running: Changes and Pull request keep their last read values..."
  is the authoritative source for FR-008's "retain last known value" wording; a reviewer checking
  CHK009 should read the two together, not FR-008 alone.
