# Specification Quality Checklist: Brand watermark

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
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

- [x] The anchor region (chat area, not the whole window) is stated once (Clarifications,
      research.md decision 1) and every FR that depends on it (FR-001, FR-008, FR-010) is
      consistent with it
- [x] The "one watermark, not one per pane" rule (FR-007) does not conflict with User Story 1's
      acceptance scenario 4 or User Story 4's acceptance scenario 2, which both describe the same
      single-instance behaviour across a split
- [x] FR-010's full-screen-view suppression and FR-018's Settings-previewable requirement do not
      contradict each other: FR-018 is satisfied by a dedicated preview element (Assumptions),
      never by showing the real mark on a suppressed screen

## Acceptance Criteria Quality

- [x] Each user story's acceptance scenarios map to at least one Given/When/Then with an
      observable outcome, not an implementation step
- [x] SC-001 to SC-006 are each measurable (a pass/fail contrast check, a 100% restart-persistence
      rate, or a yes/no observable state) without naming a UI technology

## Edge Case Coverage

- [x] A narrower-than-minimum chat area is covered (Edge Cases, FR-005's fixed minimum)
- [x] A future additional theme preset needing no new per-theme work is covered (Edge Cases,
      research.md decision 4)
- [x] A hand-edited, non-boolean stored setting value is covered (Edge Cases, FR-020)
- [x] The Settings screen's own background is covered (Edge Cases, FR-010, Assumptions)
- [x] Windows High Contrast / forced-colors is covered (FR-013)
- [x] Reduced motion is covered as moot, since nothing animates (Edge Cases)

## Dependencies & Assumptions

- [x] Dependency on the prerequisite brand-asset change (branch `brand-icon-v2`,
      `src/renderer/assets/brand/refract-hero.svg`) is explicit, and this spec is explicit that it
      does not re-author or duplicate that asset
- [x] Dependency on spec 004 (Settings screen host) and spec 007 (Appearance section, theme
      tokens) is explicit, and both are confirmed already built on `main` in this checkout (no
      sequencing risk)
- [x] Dependency on spec 005 (split chat pane, the 360px minimum pane width) is explicit
- [x] Platform assumption (Windows 11 only) is explicit and consistent with the constitution

## Notes

- Validation pass 1 (this review, during `/speckit.checklist` for this spec): all items pass, no
  spec.md wording changes needed.
- Unlike spec 007's Assumptions (which left the exact count/names of further theme presets as a
  genuinely open question for Stuart), every decision in this spec's Assumptions section is
  resolved outright per the planning brief's "make the conservative, standard choice" instruction;
  none are flagged back to Stuart as unresolved. The concrete starting numbers (opacity, size
  clamp, offset) are deliberately named, single-home constants rather than a requirements-quality
  gap — tunable later without redesigning the feature, and the opacity specifically is subject to
  a measured WCAG AA confirmation during the Polish task (plan.md), not merely asserted.
