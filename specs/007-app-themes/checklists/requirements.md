# Specification Quality Checklist: App themes

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-02
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Requirement Clarity & Consistency

- [x] "Live preview" is defined once (Clarifications) and used consistently (FR-003 to FR-005,
      FR-017) rather than redefined per requirement
- [x] The Save/Cancel/Esc/navigate-away equivalence is stated once (Assumptions) and the FRs that
      depend on it (FR-004, FR-005) do not contradict it
- [x] FR-010's minimum built-in theme count (at least one dedicated high-contrast dark variant,
      in addition to the default dark preset) does not conflict with the Assumptions' broader,
      explicitly-hedged reading ("the exact count and names of presets beyond that are
      undecided and should be confirmed with Stuart") — the Assumption flags itself as
      unresolved rather than asserting a requirement, so there is no contradiction for planning
      to resolve, only a decision to make (see research.md)

## Acceptance Criteria Quality

- [x] Each user story's acceptance scenarios map to at least one Given/When/Then with an
      observable outcome, not an implementation step
- [x] SC-001 to SC-006 are each measurable (time bound, percentage, or a yes/no observable state)
      without naming a UI technology

## Edge Case Coverage

- [x] Closing the app during an unsaved preview is covered (Edge Cases, spec.md)
- [x] A saved theme that no longer exists after an update is covered (FR-013)
- [x] A code block language with no syntax-colour entry is covered (FR-015)
- [x] Reduced motion during a theme switch is covered (FR-014)
- [x] Mermaid diagram readability per theme is covered (FR-016)

## Dependencies & Assumptions

- [x] Dependency on spec 004 (Settings screen host for the Appearance section) is explicit
- [x] Dependency on spec 001 FR-043 (Mermaid), FR-050 (code block language fallback), FR-053
      (scrollbar tokens), and the session-list state colour roles is explicit
- [x] Dependency on spec 008's profile Theme submenu sharing the same setter is explicit
- [x] Platform assumption (Windows 11 only) is explicit and consistent with the constitution

## Notes

- Validation pass 1 (this review, during `/speckit.checklist` for this spec): all items pass, no
  spec.md wording changes needed.
- The Assumptions section's hedge about further built-in dark presets beyond the required
  high-contrast variant ("the exact count and names of presets beyond that are undecided and
  should be confirmed with Stuart") is a genuine open planning question, not a requirements-
  quality defect: FR-010 states the actual minimum unambiguously, and the hedge is clearly marked
  as exceeding that minimum. Resolved as a Decision in plan.md/research.md per the planning brief
  (conservative choice: ship the existing dark theme plus one high-contrast dark preset for this
  spec; a later issue can add more presets without a breaking `ThemeId` change).
